/**
 * Permission Service
 *
 * Manages granular per-agent, per-service, per-tool permissions.
 * Service metadata is read from the @reins/servers registry — no hardcoding.
 */

import { db } from '../db/index.js';
import { agentServiceAccess, agentToolPermissions, agentServiceCredentials, agentServiceInstances, agents, credentials } from '../db/schema.js';
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

/**
 * Static permission presets per service (read/write/blocked tool lists).
 * Mirrors the registry definitions but available without async import.
 */
export const PERMISSION_PRESETS: Record<string, { read: string[]; write: string[]; blocked: string[] }> = {
  gmail: {
    read: ['gmail_list_accounts', 'gmail_list_messages', 'gmail_get_message', 'gmail_search', 'gmail_list_labels'],
    write: ['gmail_create_draft', 'gmail_send_draft'],
    blocked: ['gmail_send_message', 'gmail_delete_message'],
  },
  drive: {
    read: ['drive_list_files', 'drive_get_file', 'drive_read_file', 'drive_search'],
    write: ['drive_create_file', 'drive_update_file'],
    blocked: ['drive_share_file', 'drive_delete_file'],
  },
  calendar: {
    read: ['calendar_list_events', 'calendar_get_event', 'calendar_search_events', 'calendar_list_calendars'],
    write: ['calendar_create_event', 'calendar_update_event'],
    blocked: ['calendar_delete_event'],
  },
  'web-search': {
    read: ['web_search', 'web_search_news', 'web_search_images'],
    write: [],
    blocked: [],
  },
  browser: {
    read: ['browser_navigate', 'browser_screenshot', 'browser_get_content', 'browser_close'],
    write: ['browser_click', 'browser_type'],
    blocked: ['browser_evaluate'],
  },
};

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
 * Auto-link a credential to all agents that have the service enabled but no credential linked.
 * Updates both the legacy agent_service_access table and any instance-based entries.
 */
export async function autoLinkCredential(serviceType: string, credentialId: string): Promise<void> {
  // Legacy table
  const rows = await db
    .select()
    .from(agentServiceAccess)
    .where(and(eq(agentServiceAccess.serviceType, serviceType), eq(agentServiceAccess.enabled, true)));

  for (const row of rows) {
    if (!row.credentialId) {
      await linkCredential(row.agentId, serviceType, credentialId);
    }
  }

  // Instance-based: link credential to instances that have none
  const instances = await db
    .select()
    .from(agentServiceInstances)
    .where(and(eq(agentServiceInstances.serviceType, serviceType), eq(agentServiceInstances.enabled, true)));

  for (const inst of instances) {
    if (!inst.credentialId) {
      await db
        .update(agentServiceInstances)
        .set({ credentialId, updatedAt: new Date().toISOString() })
        .where(eq(agentServiceInstances.id, inst.id));
    }
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

// ============================================================================
// Service Instance Functions
// ============================================================================

export interface ServiceInstance {
  id: string;
  agentId: string;
  serviceType: string;
  serviceName: string;
  label: string | null;
  credentialId: string | null;
  credentialEmail: string | null;
  credentialName: string | null;
  credentialStatus: 'connected' | 'missing' | 'expired' | 'not_linked';
  enabled: boolean;
  isDefault: boolean;
  permissionLevel: PermissionLevel;
  toolCount: number;
  blockedCount: number;
  approvalRequiredCount: number;
}

export interface InstanceConfig extends ServiceInstance {
  tools: ToolPermissionEntry[];
}

export interface AgentPermissionsResponse {
  agents: Array<{
    id: string;
    name: string;
    status: string;
    instances: ServiceInstance[];
  }>;
  availableServices: Array<{ type: string; name: string; icon: string }>;
}

async function getCredentialStatus(credentialId: string | null): Promise<{
  status: 'connected' | 'missing' | 'expired' | 'not_linked';
  email: string | null;
  name: string | null;
}> {
  if (!credentialId) return { status: 'not_linked', email: null, name: null };
  const [cred] = await db.select().from(credentials).where(eq(credentials.id, credentialId));
  if (!cred) return { status: 'missing', email: null, name: null };
  if (cred.expiresAt && new Date(cred.expiresAt) < new Date()) {
    try {
      const refreshed = await credentialVault.getValidAccessToken(credentialId);
      return {
        status: refreshed ? 'connected' : 'expired',
        email: cred.accountEmail,
        name: cred.accountName,
      };
    } catch {
      return { status: 'expired', email: cred.accountEmail, name: cred.accountName };
    }
  }
  return { status: 'connected', email: cred.accountEmail, name: cred.accountName };
}

/**
 * Create a new service instance for an agent
 */
export async function createServiceInstance(
  agentId: string,
  serviceType: string,
  label?: string,
  credentialId?: string
): Promise<ServiceInstance> {
  const registry = await getRegistry();
  const def = registry.serviceRegistry.get(serviceType);
  if (!def) throw new Error(`Unknown service type: ${serviceType}`);

  // Check if this is the first instance of this type for this agent
  const existing = await db
    .select()
    .from(agentServiceInstances)
    .where(and(eq(agentServiceInstances.agentId, agentId), eq(agentServiceInstances.serviceType, serviceType)));

  const isDefault = existing.length === 0;
  const id = nanoid();
  const now = new Date().toISOString();

  // If no credential was explicitly provided, find the first matching one for this agent's user.
  // This handles the common case where the credential already exists when the service is added.
  let resolvedCredentialId = credentialId ?? null;
  if (!resolvedCredentialId) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (agent?.userId) {
      const serviceIds = def.auth.credentialServiceIds ?? [serviceType];
      const [matchingCred] = await db
        .select()
        .from(credentials)
        .where(and(inArray(credentials.serviceId, serviceIds), eq(credentials.userId, agent.userId)));
      if (matchingCred) {
        resolvedCredentialId = matchingCred.id;
      }
    }
  }

  await db.insert(agentServiceInstances).values({
    id,
    agentId,
    serviceType,
    label: label ?? null,
    credentialId: resolvedCredentialId,
    enabled: true,
    isDefault,
    createdAt: now,
    updatedAt: now,
  });

  // Also ensure agent_service_access exists and is enabled
  await setServiceAccess(agentId, serviceType, true);

  // Add to legacy junction table if we have a credential
  if (resolvedCredentialId) {
    try {
      await addServiceCredential(agentId, serviceType, resolvedCredentialId, isDefault);
    } catch {
      // May already exist
    }
  }

  return getInstanceById(id) as Promise<ServiceInstance>;
}

/**
 * Delete a service instance
 */
export async function deleteServiceInstance(instanceId: string): Promise<void> {
  const [instance] = await db
    .select()
    .from(agentServiceInstances)
    .where(eq(agentServiceInstances.id, instanceId));
  if (!instance) return;

  // Delete tool permissions for this instance
  await db
    .delete(agentToolPermissions)
    .where(eq(agentToolPermissions.instanceId, instanceId));

  // Delete the instance
  await db.delete(agentServiceInstances).where(eq(agentServiceInstances.id, instanceId));

  // If it was the default, promote the next one
  if (instance.isDefault) {
    const [next] = await db
      .select()
      .from(agentServiceInstances)
      .where(and(eq(agentServiceInstances.agentId, instance.agentId), eq(agentServiceInstances.serviceType, instance.serviceType)));
    if (next) {
      await db
        .update(agentServiceInstances)
        .set({ isDefault: true, updatedAt: new Date().toISOString() })
        .where(eq(agentServiceInstances.id, next.id));
    }
  }

  // Remove credential from legacy junction if present
  if (instance.credentialId) {
    try {
      await removeServiceCredential(instance.agentId, instance.serviceType, instance.credentialId);
    } catch {
      // May not exist
    }
  }
}

/**
 * Update a service instance
 */
export async function updateServiceInstance(
  instanceId: string,
  updates: { label?: string; credentialId?: string; enabled?: boolean }
): Promise<ServiceInstance | null> {
  const [instance] = await db
    .select()
    .from(agentServiceInstances)
    .where(eq(agentServiceInstances.id, instanceId));
  if (!instance) return null;

  const setValues: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (updates.label !== undefined) setValues.label = updates.label;
  if (updates.credentialId !== undefined) setValues.credentialId = updates.credentialId;
  if (updates.enabled !== undefined) setValues.enabled = updates.enabled;

  await db
    .update(agentServiceInstances)
    .set(setValues)
    .where(eq(agentServiceInstances.id, instanceId));

  return getInstanceById(instanceId);
}

/**
 * Set an instance as the default for its agent+serviceType
 */
export async function setInstanceDefault(instanceId: string): Promise<void> {
  const [instance] = await db
    .select()
    .from(agentServiceInstances)
    .where(eq(agentServiceInstances.id, instanceId));
  if (!instance) return;

  // Clear other defaults for same agent+service
  await db
    .update(agentServiceInstances)
    .set({ isDefault: false, updatedAt: new Date().toISOString() })
    .where(and(eq(agentServiceInstances.agentId, instance.agentId), eq(agentServiceInstances.serviceType, instance.serviceType)));

  // Set this one as default
  await db
    .update(agentServiceInstances)
    .set({ isDefault: true, updatedAt: new Date().toISOString() })
    .where(eq(agentServiceInstances.id, instanceId));
}

/**
 * Get all instances for an agent
 */
export async function getAgentInstances(agentId: string): Promise<ServiceInstance[]> {
  const registry = await getRegistry();
  const instances = await db
    .select()
    .from(agentServiceInstances)
    .where(eq(agentServiceInstances.agentId, agentId));

  const results: ServiceInstance[] = [];
  for (const inst of instances) {
    const def = registry.serviceRegistry.get(inst.serviceType);
    const credInfo = await getCredentialStatus(inst.credentialId);
    const { permissionLevel, toolCount, blockedCount, approvalRequiredCount } = await getInstancePermissionSummary(inst.id, inst.agentId, inst.serviceType);

    results.push({
      id: inst.id,
      agentId: inst.agentId,
      serviceType: inst.serviceType,
      serviceName: def?.name ?? inst.serviceType,
      label: inst.label,
      credentialId: inst.credentialId,
      credentialEmail: credInfo.email,
      credentialName: credInfo.name,
      credentialStatus: credInfo.status,
      enabled: inst.enabled,
      isDefault: inst.isDefault,
      permissionLevel,
      toolCount,
      blockedCount,
      approvalRequiredCount,
    });
  }
  return results;
}

/**
 * Get a single instance by ID with full config
 */
async function getInstanceById(instanceId: string): Promise<ServiceInstance | null> {
  const registry = await getRegistry();
  const [inst] = await db
    .select()
    .from(agentServiceInstances)
    .where(eq(agentServiceInstances.id, instanceId));
  if (!inst) return null;

  const def = registry.serviceRegistry.get(inst.serviceType);
  const credInfo = await getCredentialStatus(inst.credentialId);
  const { permissionLevel, toolCount, blockedCount, approvalRequiredCount } = await getInstancePermissionSummary(inst.id, inst.agentId, inst.serviceType);

  return {
    id: inst.id,
    agentId: inst.agentId,
    serviceType: inst.serviceType,
    serviceName: def?.name ?? inst.serviceType,
    label: inst.label,
    credentialId: inst.credentialId,
    credentialEmail: credInfo.email,
    credentialName: credInfo.name,
    credentialStatus: credInfo.status,
    enabled: inst.enabled,
    isDefault: inst.isDefault,
    permissionLevel,
    toolCount,
    blockedCount,
    approvalRequiredCount,
  };
}

/**
 * Get instance config with tools list
 */
export async function getInstanceConfig(instanceId: string): Promise<InstanceConfig | null> {
  const instance = await getInstanceById(instanceId);
  if (!instance) return null;

  const registry = await getRegistry();
  const def = registry.serviceRegistry.get(instance.serviceType);
  if (!def) return { ...instance, tools: [] };

  // Get tool overrides for this instance (fall back to agent+service level)
  const instanceToolOverrides = await db
    .select()
    .from(agentToolPermissions)
    .where(eq(agentToolPermissions.instanceId, instanceId));

  const agentToolOverrides = await db
    .select()
    .from(agentToolPermissions)
    .where(and(
      eq(agentToolPermissions.agentId, instance.agentId),
      eq(agentToolPermissions.serviceType, instance.serviceType),
      // instance_id IS NULL (legacy overrides)
    ));

  const overrideMap = new Map<string, ToolPermission>();
  // First apply agent-level overrides (where instanceId is null)
  for (const o of agentToolOverrides) {
    if (!o.instanceId) overrideMap.set(o.toolName, o.permission as ToolPermission);
  }
  // Then apply instance-specific overrides (take priority)
  for (const o of instanceToolOverrides) {
    overrideMap.set(o.toolName, o.permission as ToolPermission);
  }

  const defaultPerms = getDefaultPermsFromDef(def);
  const serverTools = serverManager.getAllServerTools(instance.serviceType);
  const toolNames = serverTools.length > 0 ? serverTools.map((t) => t.name) : Object.keys(defaultPerms);

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

  return { ...instance, tools };
}

/**
 * Set permission level for an instance
 */
export async function setInstancePermissionLevel(
  instanceId: string,
  level: PermissionLevel
): Promise<void> {
  const [instance] = await db
    .select()
    .from(agentServiceInstances)
    .where(eq(agentServiceInstances.id, instanceId));
  if (!instance) throw new Error('Instance not found');

  if (level === 'custom') {
    throw new Error("Cannot set permission level to 'custom'. Use individual tool permissions instead.");
  }

  if (level === 'none') {
    await db
      .update(agentServiceInstances)
      .set({ enabled: false, updatedAt: new Date().toISOString() })
      .where(eq(agentServiceInstances.id, instanceId));
    return;
  }

  await db
    .update(agentServiceInstances)
    .set({ enabled: true, updatedAt: new Date().toISOString() })
    .where(eq(agentServiceInstances.id, instanceId));

  const registry = await getRegistry();
  const def = registry.serviceRegistry.get(instance.serviceType);
  if (!def) throw new Error(`Unknown service type: ${instance.serviceType}`);

  const preset = def.permissions;
  const perms: Record<string, ToolPermission> = {};

  for (const tool of preset.read) perms[tool] = 'allow';
  for (const tool of preset.write) perms[tool] = level === 'read' ? 'block' : 'require_approval';
  for (const tool of preset.blocked) perms[tool] = 'block';

  // Apply tool permissions scoped to this instance
  for (const [toolName, permission] of Object.entries(perms)) {
    await setInstanceToolPermission(instanceId, toolName, permission);
  }

  // Also keep agent-level service access in sync
  await setServiceAccess(instance.agentId, instance.serviceType, true);
}

/**
 * Set a tool permission for an instance
 */
export async function setInstanceToolPermission(
  instanceId: string,
  toolName: string,
  permission: ToolPermission
): Promise<void> {
  const [instance] = await db
    .select()
    .from(agentServiceInstances)
    .where(eq(agentServiceInstances.id, instanceId));
  if (!instance) throw new Error('Instance not found');

  const [existing] = await db
    .select()
    .from(agentToolPermissions)
    .where(and(
      eq(agentToolPermissions.instanceId, instanceId),
      eq(agentToolPermissions.toolName, toolName)
    ));

  if (existing) {
    await db
      .update(agentToolPermissions)
      .set({ permission, updatedAt: new Date().toISOString() })
      .where(eq(agentToolPermissions.id, existing.id));
  } else {
    await db.insert(agentToolPermissions).values({
      id: nanoid(),
      agentId: instance.agentId,
      serviceType: instance.serviceType,
      toolName,
      permission,
      instanceId,
    });
  }

  // If this is the default instance, also update agent-level permission for backward compat
  if (instance.isDefault) {
    await setToolPermission(instance.agentId, instance.serviceType, toolName, permission);
  }
}

/**
 * Reset an instance tool permission to default
 */
export async function resetInstanceToolPermission(
  instanceId: string,
  toolName: string
): Promise<void> {
  await db
    .delete(agentToolPermissions)
    .where(and(
      eq(agentToolPermissions.instanceId, instanceId),
      eq(agentToolPermissions.toolName, toolName)
    ));
}

/**
 * Get effective permissions for an instance
 */
export async function getEffectiveInstancePermissions(
  instanceId: string
): Promise<{ enabled: boolean; tools: Record<string, ToolPermission> }> {
  const [instance] = await db
    .select()
    .from(agentServiceInstances)
    .where(eq(agentServiceInstances.id, instanceId));
  if (!instance || !instance.enabled) return { enabled: false, tools: {} };

  const registry = await getRegistry();
  const def = registry.serviceRegistry.get(instance.serviceType);
  const defaultPerms = def ? getDefaultPermsFromDef(def) : {};
  const tools: Record<string, ToolPermission> = { ...defaultPerms };

  // Apply instance-specific overrides
  const overrides = await db
    .select()
    .from(agentToolPermissions)
    .where(eq(agentToolPermissions.instanceId, instanceId));
  for (const o of overrides) {
    tools[o.toolName] = o.permission as ToolPermission;
  }

  // If no instance-level overrides, fall back to agent-level
  if (overrides.length === 0) {
    const agentOverrides = await db
      .select()
      .from(agentToolPermissions)
      .where(and(
        eq(agentToolPermissions.agentId, instance.agentId),
        eq(agentToolPermissions.serviceType, instance.serviceType),
      ));
    for (const o of agentOverrides) {
      if (!o.instanceId) tools[o.toolName] = o.permission as ToolPermission;
    }
  }

  return { enabled: true, tools };
}

/**
 * Helper to compute permission summary for an instance
 */
async function getInstancePermissionSummary(
  instanceId: string,
  _agentId: string,
  serviceType: string
): Promise<{ permissionLevel: PermissionLevel; toolCount: number; blockedCount: number; approvalRequiredCount: number }> {
  const registry = await getRegistry();
  const def = registry.serviceRegistry.get(serviceType);
  if (!def) return { permissionLevel: 'none', toolCount: 0, blockedCount: 0, approvalRequiredCount: 0 };

  const [instance] = await db
    .select()
    .from(agentServiceInstances)
    .where(eq(agentServiceInstances.id, instanceId));

  if (!instance?.enabled) {
    return { permissionLevel: 'none', toolCount: Object.keys(getDefaultPermsFromDef(def)).length, blockedCount: 0, approvalRequiredCount: 0 };
  }

  const { tools: effectiveTools } = await getEffectiveInstancePermissions(instanceId);
  const toolNames = Object.keys(effectiveTools);
  let blockedCount = 0;
  let approvalRequiredCount = 0;
  for (const perm of Object.values(effectiveTools)) {
    if (perm === 'block') blockedCount++;
    if (perm === 'require_approval') approvalRequiredCount++;
  }

  const permissionLevel = calculatePermissionLevelFromTools(def.permissions, effectiveTools);

  return { permissionLevel, toolCount: toolNames.length, blockedCount, approvalRequiredCount };
}

/**
 * Get all agents with their instances (new response shape)
 */
export async function getAgentPermissions(userId?: string): Promise<AgentPermissionsResponse> {
  const registry = await getRegistry();
  const allAgents = userId
    ? await db.select().from(agents).where(eq(agents.userId, userId))
    : await db.select().from(agents);

  const agentResults: AgentPermissionsResponse['agents'] = [];
  for (const agent of allAgents) {
    const instances = await getAgentInstances(agent.id);
    agentResults.push({
      id: agent.id,
      name: agent.name,
      status: agent.status,
      instances,
    });
  }

  const availableServices = registry.serviceDefinitions.map((def) => ({
    type: def.type,
    name: def.name,
    icon: def.type, // frontend maps type to icon
  }));

  return { agents: agentResults, availableServices };
}
