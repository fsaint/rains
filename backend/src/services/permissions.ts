/**
 * Permission Service
 *
 * Manages granular per-agent, per-service, per-tool permissions.
 * Service metadata is read from the @reins/servers registry — no hardcoding.
 */

import { db } from '../db/index.js';
import { agentServiceAccess, agentToolPermissions, agentServiceCredentials, agents, credentials } from '../db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { serverManager } from '../mcp/server-manager.js';
import { credentialVault } from '../credentials/vault.js';

// Lazy-loaded registry (loaded on first use to avoid import ordering issues)
let _registry: typeof import('@reins/servers') | null = null;
async function getRegistry() {
  if (!_registry) {
    _registry = await import('@reins/servers');
  }
  return _registry;
}

export type ToolPermission = 'allow' | 'block' | 'require_approval';
export type PermissionLevel = 'none' | 'read' | 'full' | 'custom';

export interface ServiceAccess {
  serviceType: string;
  enabled: boolean;
  credentialId: string | null;
  credentialStatus: 'connected' | 'missing' | 'expired' | 'not_linked';
}

export interface ToolPermissionEntry {
  toolName: string;
  description: string;
  permission: ToolPermission;
  isDefault: boolean;
}

export interface LinkedCredential {
  credentialId: string;
  accountEmail: string | null;
  accountName: string | null;
  isDefault: boolean;
  status: 'connected' | 'missing' | 'expired';
}

export interface AgentServiceConfig {
  agentId: string;
  agentName: string;
  serviceType: string;
  serviceName: string;
  enabled: boolean;
  credentialId: string | null;
  credentialStatus: 'connected' | 'missing' | 'expired' | 'not_linked';
  linkedCredentials: LinkedCredential[];
  tools: ToolPermissionEntry[];
}

export interface PermissionMatrixCell {
  agentId: string;
  serviceType: string;
  enabled: boolean;
  credentialStatus: 'connected' | 'missing' | 'expired' | 'not_linked';
  toolCount: number;
  blockedCount: number;
  approvalRequiredCount: number;
  permissionLevel: PermissionLevel;
  linkedCredentialCount: number;
}

export interface PermissionMatrix {
  agents: Array<{ id: string; name: string; status: string }>;
  services: Array<{ type: string; name: string }>;
  cells: PermissionMatrixCell[];
}

/**
 * Get default permissions for a service from the registry
 */
function getDefaultPermsFromDef(def: { permissions: { read: string[]; write: string[]; blocked: string[] } }): Record<string, ToolPermission> {
  const result: Record<string, ToolPermission> = {};
  for (const tool of def.permissions.read) result[tool] = 'allow';
  for (const tool of def.permissions.write) result[tool] = 'require_approval';
  for (const tool of def.permissions.blocked) result[tool] = 'block';
  return result;
}

/**
 * Calculate permission level from tool permissions
 */
function calculatePermissionLevelFromTools(
  preset: { read: string[]; write: string[]; blocked: string[] },
  tools: Record<string, ToolPermission>
): PermissionLevel {
  const readToolsAllowed = preset.read.every((tool) => tools[tool] === 'allow');
  const blockedToolsBlocked = preset.blocked.every((tool) => tools[tool] === 'block');
  const writeToolsBlocked = preset.write.length === 0 || preset.write.every((tool) => tools[tool] === 'block');
  const writeToolsApproval = preset.write.length === 0 || preset.write.every((tool) => tools[tool] === 'require_approval');

  if (!blockedToolsBlocked) return 'custom';
  if (!readToolsAllowed) return 'custom';
  if (writeToolsBlocked) return 'read';
  if (writeToolsApproval) return 'full';
  return 'custom';
}

/**
 * Get the full permission matrix for all agents and services
 */
export async function getPermissionMatrix(userId?: string): Promise<PermissionMatrix> {
  const registry = await getRegistry();

  const allAgents = userId
    ? await db.select().from(agents).where(eq(agents.userId, userId))
    : await db.select().from(agents);
  const accessRecords = await db.select().from(agentServiceAccess);
  const toolPerms = await db.select().from(agentToolPermissions);
  const allCredentials = await db.select().from(credentials);
  const credentialMap = new Map(allCredentials.map((c) => [c.id, c]));
  const allLinkedCreds = await db.select().from(agentServiceCredentials);

  const services = registry.serviceDefinitions.map((def) => ({
    type: def.type,
    name: def.name,
  }));

  const cells: PermissionMatrixCell[] = [];

  for (const agent of allAgents) {
    for (const def of registry.serviceDefinitions) {
      const access = accessRecords.find(
        (r) => r.agentId === agent.id && r.serviceType === def.type
      );

      // Check linked credentials from junction table
      const linkedCreds = allLinkedCreds.filter(
        (lc) => lc.agentId === agent.id && lc.serviceType === def.type
      );

      let credentialStatus: 'connected' | 'missing' | 'expired' | 'not_linked' = 'not_linked';
      if (linkedCreds.length > 0) {
        // Aggregate: connected if any is connected, expired if all expired, missing if all missing
        const statuses: string[] = [];
        for (const lc of linkedCreds) {
          const cred = credentialMap.get(lc.credentialId);
          if (!cred) {
            statuses.push('missing');
          } else if (cred.expiresAt && new Date(cred.expiresAt) < new Date()) {
            const refreshed = await credentialVault.getValidAccessToken(lc.credentialId);
            statuses.push(refreshed ? 'connected' : 'expired');
          } else {
            statuses.push('connected');
          }
        }
        if (statuses.includes('connected')) credentialStatus = 'connected';
        else if (statuses.includes('expired')) credentialStatus = 'expired';
        else credentialStatus = 'missing';
      } else if (access?.credentialId) {
        // Fallback to legacy single credential
        const cred = credentialMap.get(access.credentialId);
        if (!cred) {
          credentialStatus = 'missing';
        } else if (cred.expiresAt && new Date(cred.expiresAt) < new Date()) {
          const refreshed = await credentialVault.getValidAccessToken(access.credentialId);
          credentialStatus = refreshed ? 'connected' : 'expired';
        } else {
          credentialStatus = 'connected';
        }
      }

      const agentToolPerms = toolPerms.filter(
        (p) => p.agentId === agent.id && p.serviceType === def.type
      );

      const defaultPerms = getDefaultPermsFromDef(def);
      const toolNames = Object.keys(defaultPerms);

      let blockedCount = 0;
      let approvalRequiredCount = 0;
      const effectiveTools: Record<string, ToolPermission> = {};

      for (const toolName of toolNames) {
        const override = agentToolPerms.find((p) => p.toolName === toolName);
        const perm = override ? (override.permission as ToolPermission) : defaultPerms[toolName];
        effectiveTools[toolName] = perm;
        if (perm === 'block') blockedCount++;
        if (perm === 'require_approval') approvalRequiredCount++;
      }

      let permissionLevel: PermissionLevel = 'none';
      if (access?.enabled) {
        permissionLevel = calculatePermissionLevelFromTools(def.permissions, effectiveTools);
      }

      cells.push({
        agentId: agent.id,
        serviceType: def.type,
        enabled: access?.enabled ?? false,
        credentialStatus,
        toolCount: toolNames.length,
        blockedCount,
        approvalRequiredCount,
        permissionLevel,
        linkedCredentialCount: linkedCreds.length || (access?.credentialId ? 1 : 0),
      });
    }
  }

  return {
    agents: allAgents.map((a) => ({ id: a.id, name: a.name, status: a.status })),
    services,
    cells,
  };
}

/**
 * Get detailed service configuration for an agent
 */
export async function getAgentServiceConfig(
  agentId: string,
  serviceType: string
): Promise<AgentServiceConfig | null> {
  const registry = await getRegistry();
  const def = registry.serviceRegistry.get(serviceType);
  if (!def) return null;

  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) return null;

  const [access] = await db
    .select()
    .from(agentServiceAccess)
    .where(and(eq(agentServiceAccess.agentId, agentId), eq(agentServiceAccess.serviceType, serviceType)));

  const toolOverrides = await db
    .select()
    .from(agentToolPermissions)
    .where(and(eq(agentToolPermissions.agentId, agentId), eq(agentToolPermissions.serviceType, serviceType)));

  const overrideMap = new Map(toolOverrides.map((o) => [o.toolName, o.permission as ToolPermission]));

  // Build linked credentials from junction table
  const linkedCredsRows = await db
    .select()
    .from(agentServiceCredentials)
    .where(and(eq(agentServiceCredentials.agentId, agentId), eq(agentServiceCredentials.serviceType, serviceType)));

  const linkedCredentials: LinkedCredential[] = [];
  let credentialStatus: 'connected' | 'missing' | 'expired' | 'not_linked' = 'not_linked';

  if (linkedCredsRows.length > 0) {
    for (const lc of linkedCredsRows) {
      const [cred] = await db.select().from(credentials).where(eq(credentials.id, lc.credentialId));
      let status: 'connected' | 'missing' | 'expired' = 'missing';
      if (cred) {
        if (cred.expiresAt && new Date(cred.expiresAt) < new Date()) {
          const refreshed = await credentialVault.getValidAccessToken(lc.credentialId);
          status = refreshed ? 'connected' : 'expired';
        } else {
          status = 'connected';
        }
      }
      linkedCredentials.push({
        credentialId: lc.credentialId,
        accountEmail: cred?.accountEmail ?? null,
        accountName: cred?.accountName ?? null,
        isDefault: lc.isDefault,
        status,
      });
    }
    // Aggregate status
    if (linkedCredentials.some((lc) => lc.status === 'connected')) credentialStatus = 'connected';
    else if (linkedCredentials.some((lc) => lc.status === 'expired')) credentialStatus = 'expired';
    else credentialStatus = 'missing';
  } else if (access?.credentialId) {
    // Fallback to legacy single credential
    const [cred] = await db.select().from(credentials).where(eq(credentials.id, access.credentialId));
    if (!cred) {
      credentialStatus = 'missing';
    } else if (cred.expiresAt && new Date(cred.expiresAt) < new Date()) {
      const refreshed = await credentialVault.getValidAccessToken(access.credentialId);
      credentialStatus = refreshed ? 'connected' : 'expired';
    } else {
      credentialStatus = 'connected';
    }
    linkedCredentials.push({
      credentialId: access.credentialId,
      accountEmail: cred?.accountEmail ?? null,
      accountName: cred?.accountName ?? null,
      isDefault: true,
      status: credentialStatus === 'not_linked' ? 'missing' : credentialStatus as 'connected' | 'missing' | 'expired',
    });
  }

  // Build tools list — prefer live server tools, fall back to registry definition
  const serverTools = serverManager.getAllServerTools(serviceType);
  const defaultPerms = getDefaultPermsFromDef(def);

  const toolNames = serverTools.length > 0
    ? serverTools.map((t) => t.name)
    : Object.keys(defaultPerms);

  const tools: ToolPermissionEntry[] = [];
  for (const toolName of toolNames) {
    const serverTool = serverTools.find((t) => t.name === toolName);
    const override = overrideMap.get(toolName);
    const defaultPerm = defaultPerms[toolName] ?? 'allow';

    tools.push({
      toolName,
      description: serverTool?.description ?? toolName,
      permission: override ?? defaultPerm,
      isDefault: !override,
    });
  }

  return {
    agentId,
    agentName: agent.name,
    serviceType,
    serviceName: def.name,
    enabled: access?.enabled ?? false,
    credentialId: access?.credentialId ?? null,
    credentialStatus,
    linkedCredentials,
    tools,
  };
}

/**
 * Enable or disable a service for an agent
 */
export async function setServiceAccess(
  agentId: string,
  serviceType: string,
  enabled: boolean
): Promise<void> {
  const [existing] = await db
    .select()
    .from(agentServiceAccess)
    .where(and(eq(agentServiceAccess.agentId, agentId), eq(agentServiceAccess.serviceType, serviceType)));

  if (existing) {
    await db
      .update(agentServiceAccess)
      .set({ enabled, updatedAt: new Date().toISOString() })
      .where(eq(agentServiceAccess.id, existing.id));
  } else {
    await db.insert(agentServiceAccess).values({
      id: nanoid(),
      agentId,
      serviceType,
      enabled,
      credentialId: null,
    });
  }
}

/**
 * Link a credential to an agent's service
 */
export async function linkCredential(
  agentId: string,
  serviceType: string,
  credentialId: string
): Promise<void> {
  const [existing] = await db
    .select()
    .from(agentServiceAccess)
    .where(and(eq(agentServiceAccess.agentId, agentId), eq(agentServiceAccess.serviceType, serviceType)));

  if (existing) {
    await db
      .update(agentServiceAccess)
      .set({ credentialId, updatedAt: new Date().toISOString() })
      .where(eq(agentServiceAccess.id, existing.id));
  } else {
    await db.insert(agentServiceAccess).values({
      id: nanoid(),
      agentId,
      serviceType,
      enabled: false,
      credentialId,
    });
  }
}

/**
 * Unlink a credential from an agent's service
 */
export async function unlinkCredential(agentId: string, serviceType: string): Promise<void> {
  const [existing] = await db
    .select()
    .from(agentServiceAccess)
    .where(and(eq(agentServiceAccess.agentId, agentId), eq(agentServiceAccess.serviceType, serviceType)));

  if (existing) {
    await db
      .update(agentServiceAccess)
      .set({ credentialId: null, updatedAt: new Date().toISOString() })
      .where(eq(agentServiceAccess.id, existing.id));
  }
}

/**
 * Set permission for a specific tool
 */
export async function setToolPermission(
  agentId: string,
  serviceType: string,
  toolName: string,
  permission: ToolPermission
): Promise<void> {
  const [existing] = await db
    .select()
    .from(agentToolPermissions)
    .where(
      and(
        eq(agentToolPermissions.agentId, agentId),
        eq(agentToolPermissions.serviceType, serviceType),
        eq(agentToolPermissions.toolName, toolName)
      )
    );

  if (existing) {
    await db
      .update(agentToolPermissions)
      .set({ permission, updatedAt: new Date().toISOString() })
      .where(eq(agentToolPermissions.id, existing.id));
  } else {
    await db.insert(agentToolPermissions).values({
      id: nanoid(),
      agentId,
      serviceType,
      toolName,
      permission,
    });
  }
}

/**
 * Reset a tool permission to default (remove override)
 */
export async function resetToolPermission(
  agentId: string,
  serviceType: string,
  toolName: string
): Promise<void> {
  await db
    .delete(agentToolPermissions)
    .where(
      and(
        eq(agentToolPermissions.agentId, agentId),
        eq(agentToolPermissions.serviceType, serviceType),
        eq(agentToolPermissions.toolName, toolName)
      )
    );
}

/**
 * Bulk set tool permissions for a service
 */
export async function setServiceToolPermissions(
  agentId: string,
  serviceType: string,
  permissions: Record<string, ToolPermission>
): Promise<void> {
  for (const [toolName, permission] of Object.entries(permissions)) {
    await setToolPermission(agentId, serviceType, toolName, permission);
  }
}

/**
 * Get effective permissions for an agent's service
 */
export async function getEffectivePermissions(
  agentId: string,
  serviceType: string
): Promise<{ enabled: boolean; tools: Record<string, ToolPermission> }> {
  const [access] = await db
    .select()
    .from(agentServiceAccess)
    .where(and(eq(agentServiceAccess.agentId, agentId), eq(agentServiceAccess.serviceType, serviceType)));

  if (!access?.enabled) {
    return { enabled: false, tools: {} };
  }

  const toolOverrides = await db
    .select()
    .from(agentToolPermissions)
    .where(and(eq(agentToolPermissions.agentId, agentId), eq(agentToolPermissions.serviceType, serviceType)));

  const registry = await getRegistry();
  const def = registry.serviceRegistry.get(serviceType);
  const defaultPerms = def ? getDefaultPermsFromDef(def) : {};
  const tools: Record<string, ToolPermission> = { ...defaultPerms };

  for (const override of toolOverrides) {
    tools[override.toolName] = override.permission as ToolPermission;
  }

  return { enabled: true, tools };
}

/**
 * Check if agent has access to a specific tool
 */
export async function canAccessTool(
  agentId: string,
  serviceType: string,
  toolName: string
): Promise<{ allowed: boolean; requiresApproval: boolean }> {
  const { enabled, tools } = await getEffectivePermissions(agentId, serviceType);

  if (!enabled) {
    return { allowed: false, requiresApproval: false };
  }

  const permission = tools[toolName] ?? 'block';

  return {
    allowed: permission !== 'block',
    requiresApproval: permission === 'require_approval',
  };
}

/**
 * List all available credentials for a service type
 */
export async function getCredentialsForService(
  serviceType: string,
  userId?: string
): Promise<Array<{
  id: string;
  type: string;
  status: string;
  expiresAt: string | null;
  accountEmail: string | null;
  accountName: string | null;
}>> {
  const registry = await getRegistry();
  const def = registry.serviceRegistry.get(serviceType);

  // Use credentialServiceIds from registry if available, otherwise just the serviceType
  const serviceIds = def?.auth.credentialServiceIds ?? [serviceType];
  const creds = userId
    ? await db.select().from(credentials).where(and(inArray(credentials.serviceId, serviceIds), eq(credentials.userId, userId)))
    : await db.select().from(credentials).where(inArray(credentials.serviceId, serviceIds));

  const results = [];
  for (const c of creds) {
    let status = 'valid';
    if (c.expiresAt && new Date(c.expiresAt) < new Date()) {
      // Try refreshing before reporting expired
      const refreshed = await credentialVault.getValidAccessToken(c.id);
      status = refreshed ? 'valid' : 'expired';
    }
    results.push({
      id: c.id,
      type: c.type,
      status,
      expiresAt: c.expiresAt,
      accountEmail: c.accountEmail,
      accountName: c.accountName,
    });
  }
  return results;
}

/**
 * Set permission level for an agent's service.
 */
export async function setPermissionLevel(
  agentId: string,
  serviceType: string,
  level: PermissionLevel
): Promise<void> {
  if (level === 'custom') {
    throw new Error("Cannot set permission level to 'custom'. Use individual tool permissions instead.");
  }

  if (level === 'none') {
    await setServiceAccess(agentId, serviceType, false);
    return;
  }

  await setServiceAccess(agentId, serviceType, true);

  const registry = await getRegistry();
  const def = registry.serviceRegistry.get(serviceType);
  if (!def) throw new Error(`Unknown service type: ${serviceType}`);

  const preset = def.permissions;
  const permissions: Record<string, ToolPermission> = {};

  for (const tool of preset.read) {
    permissions[tool] = 'allow';
  }

  for (const tool of preset.write) {
    permissions[tool] = level === 'read' ? 'block' : 'require_approval';
  }

  for (const tool of preset.blocked) {
    permissions[tool] = 'block';
  }

  await setServiceToolPermissions(agentId, serviceType, permissions);
}

/**
 * Get the current permission level for an agent's service.
 */
export async function getPermissionLevel(
  agentId: string,
  serviceType: string
): Promise<PermissionLevel> {
  const { enabled, tools } = await getEffectivePermissions(agentId, serviceType);

  if (!enabled) {
    return 'none';
  }

  const registry = await getRegistry();
  const def = registry.serviceRegistry.get(serviceType);
  if (!def) return 'custom';

  return calculatePermissionLevelFromTools(def.permissions, tools);
}

// ============================================================================
// Multi-Credential Functions
// ============================================================================

/**
 * Add a credential to an agent's service (multi-account)
 */
export async function addServiceCredential(
  agentId: string,
  serviceType: string,
  credentialId: string,
  isDefault?: boolean
): Promise<void> {
  // Check if any credentials already linked
  const existing = await db
    .select()
    .from(agentServiceCredentials)
    .where(and(eq(agentServiceCredentials.agentId, agentId), eq(agentServiceCredentials.serviceType, serviceType)));

  // Auto-default if first credential
  const shouldBeDefault = isDefault ?? existing.length === 0;

  // If setting as default, unset existing default
  if (shouldBeDefault && existing.length > 0) {
    await db
      .update(agentServiceCredentials)
      .set({ isDefault: false })
      .where(and(eq(agentServiceCredentials.agentId, agentId), eq(agentServiceCredentials.serviceType, serviceType)));
  }

  await db.insert(agentServiceCredentials).values({
    id: nanoid(),
    agentId,
    serviceType,
    credentialId,
    isDefault: shouldBeDefault,
  });

  // Also update legacy single credential to the default
  if (shouldBeDefault) {
    await linkCredential(agentId, serviceType, credentialId);
  }
}

/**
 * Remove a credential from an agent's service
 */
export async function removeServiceCredential(
  agentId: string,
  serviceType: string,
  credentialId: string
): Promise<void> {
  const [removed] = await db
    .select()
    .from(agentServiceCredentials)
    .where(
      and(
        eq(agentServiceCredentials.agentId, agentId),
        eq(agentServiceCredentials.serviceType, serviceType),
        eq(agentServiceCredentials.credentialId, credentialId)
      )
    );

  await db
    .delete(agentServiceCredentials)
    .where(
      and(
        eq(agentServiceCredentials.agentId, agentId),
        eq(agentServiceCredentials.serviceType, serviceType),
        eq(agentServiceCredentials.credentialId, credentialId)
      )
    );

  // If removed credential was the default, promote next
  if (removed?.isDefault) {
    const [next] = await db
      .select()
      .from(agentServiceCredentials)
      .where(and(eq(agentServiceCredentials.agentId, agentId), eq(agentServiceCredentials.serviceType, serviceType)));

    if (next) {
      await db
        .update(agentServiceCredentials)
        .set({ isDefault: true })
        .where(eq(agentServiceCredentials.id, next.id));
      await linkCredential(agentId, serviceType, next.credentialId);
    } else {
      // No more credentials, clear legacy link
      await unlinkCredential(agentId, serviceType);
    }
  }
}

/**
 * Set default credential for an agent's service
 */
export async function setDefaultCredential(
  agentId: string,
  serviceType: string,
  credentialId: string
): Promise<void> {
  // Unset old default
  await db
    .update(agentServiceCredentials)
    .set({ isDefault: false })
    .where(and(eq(agentServiceCredentials.agentId, agentId), eq(agentServiceCredentials.serviceType, serviceType)));

  // Set new default
  await db
    .update(agentServiceCredentials)
    .set({ isDefault: true })
    .where(
      and(
        eq(agentServiceCredentials.agentId, agentId),
        eq(agentServiceCredentials.serviceType, serviceType),
        eq(agentServiceCredentials.credentialId, credentialId)
      )
    );

  // Update legacy single credential
  await linkCredential(agentId, serviceType, credentialId);
}

/**
 * Get all linked credentials for an agent's service
 */
export async function getLinkedCredentials(
  agentId: string,
  serviceType: string
): Promise<LinkedCredential[]> {
  const rows = await db
    .select()
    .from(agentServiceCredentials)
    .where(and(eq(agentServiceCredentials.agentId, agentId), eq(agentServiceCredentials.serviceType, serviceType)));

  const result: LinkedCredential[] = [];
  for (const row of rows) {
    const [cred] = await db.select().from(credentials).where(eq(credentials.id, row.credentialId));
    let status: 'connected' | 'missing' | 'expired' = 'missing';
    if (cred) {
      if (cred.expiresAt && new Date(cred.expiresAt) < new Date()) {
        const refreshed = await credentialVault.getValidAccessToken(row.credentialId);
        status = refreshed ? 'connected' : 'expired';
      } else {
        status = 'connected';
      }
    }
    result.push({
      credentialId: row.credentialId,
      accountEmail: cred?.accountEmail ?? null,
      accountName: cred?.accountName ?? null,
      isDefault: row.isDefault,
      status,
    });
  }
  return result;
}
