/**
 * Permission Service
 *
 * Manages granular per-agent, per-service, per-tool permissions.
 */

import { db } from '../db/index.js';
import { agentServiceAccess, agentToolPermissions, agents, credentials } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { serverManager } from '../mcp/server-manager.js';

export type ServiceType = 'gmail' | 'drive' | 'calendar' | 'web-search' | 'browser';
export type ToolPermission = 'allow' | 'block' | 'require_approval';

export interface ServiceAccess {
  serviceType: ServiceType;
  enabled: boolean;
  credentialId: string | null;
  credentialStatus: 'connected' | 'missing' | 'expired' | 'not_linked';
}

export interface ToolPermissionEntry {
  toolName: string;
  description: string;
  permission: ToolPermission;
  isDefault: boolean; // true if using default, false if overridden
}

export interface AgentServiceConfig {
  agentId: string;
  agentName: string;
  serviceType: ServiceType;
  serviceName: string;
  enabled: boolean;
  credentialId: string | null;
  credentialStatus: 'connected' | 'missing' | 'expired' | 'not_linked';
  tools: ToolPermissionEntry[];
}

export interface PermissionMatrixCell {
  agentId: string;
  serviceType: ServiceType;
  enabled: boolean;
  credentialStatus: 'connected' | 'missing' | 'expired' | 'not_linked';
  toolCount: number;
  blockedCount: number;
  approvalRequiredCount: number;
}

export interface PermissionMatrix {
  agents: Array<{ id: string; name: string; status: string }>;
  services: Array<{ type: ServiceType; name: string }>;
  cells: PermissionMatrixCell[];
}

// Service metadata
const SERVICE_METADATA: Record<ServiceType, { name: string; defaultPermissions: Record<string, ToolPermission> }> = {
  gmail: {
    name: 'Gmail',
    defaultPermissions: {
      gmail_list_messages: 'allow',
      gmail_get_message: 'allow',
      gmail_search: 'allow',
      gmail_create_draft: 'require_approval',
      gmail_send_draft: 'require_approval',
      gmail_send_message: 'block',
      gmail_delete_message: 'block',
    },
  },
  drive: {
    name: 'Google Drive',
    defaultPermissions: {
      drive_list_files: 'allow',
      drive_get_file: 'allow',
      drive_read_file: 'allow',
      drive_search: 'allow',
      drive_create_file: 'require_approval',
      drive_update_file: 'require_approval',
      drive_share_file: 'block',
      drive_delete_file: 'block',
    },
  },
  calendar: {
    name: 'Google Calendar',
    defaultPermissions: {
      calendar_list_events: 'allow',
      calendar_get_event: 'allow',
      calendar_search_events: 'allow',
      calendar_list_calendars: 'allow',
      calendar_create_event: 'require_approval',
      calendar_update_event: 'require_approval',
      calendar_delete_event: 'block',
    },
  },
  'web-search': {
    name: 'Web Search',
    defaultPermissions: {
      web_search: 'allow',
      web_search_news: 'allow',
      web_search_images: 'allow',
    },
  },
  browser: {
    name: 'Browser',
    defaultPermissions: {
      browser_navigate: 'allow',
      browser_screenshot: 'allow',
      browser_get_content: 'allow',
      browser_click: 'require_approval',
      browser_type: 'require_approval',
      browser_evaluate: 'block',
      browser_close: 'allow',
    },
  },
};

/**
 * Get the full permission matrix for all agents and services
 */
export async function getPermissionMatrix(): Promise<PermissionMatrix> {
  // Get all agents
  const allAgents = await db.select().from(agents);

  // Get all service access records
  const accessRecords = await db.select().from(agentServiceAccess);

  // Get all tool permission overrides
  const toolPerms = await db.select().from(agentToolPermissions);

  // Get all credentials for status checking
  const allCredentials = await db.select().from(credentials);
  const credentialMap = new Map(allCredentials.map((c) => [c.id, c]));

  const services: Array<{ type: ServiceType; name: string }> = [
    { type: 'gmail', name: 'Gmail' },
    { type: 'drive', name: 'Google Drive' },
    { type: 'calendar', name: 'Google Calendar' },
    { type: 'web-search', name: 'Web Search' },
    { type: 'browser', name: 'Browser' },
  ];

  const cells: PermissionMatrixCell[] = [];

  for (const agent of allAgents) {
    for (const service of services) {
      const access = accessRecords.find(
        (r) => r.agentId === agent.id && r.serviceType === service.type
      );

      // Determine credential status
      let credentialStatus: 'connected' | 'missing' | 'expired' | 'not_linked' = 'not_linked';
      if (access?.credentialId) {
        const cred = credentialMap.get(access.credentialId);
        if (!cred) {
          credentialStatus = 'missing';
        } else if (cred.expiresAt && new Date(cred.expiresAt) < new Date()) {
          credentialStatus = 'expired';
        } else {
          credentialStatus = 'connected';
        }
      }

      // Count tools and permissions
      const agentToolPerms = toolPerms.filter(
        (p) => p.agentId === agent.id && p.serviceType === service.type
      );

      const defaultPerms = SERVICE_METADATA[service.type].defaultPermissions;
      const toolNames = Object.keys(defaultPerms);

      let blockedCount = 0;
      let approvalRequiredCount = 0;

      for (const toolName of toolNames) {
        const override = agentToolPerms.find((p) => p.toolName === toolName);
        const perm = override ? (override.permission as ToolPermission) : defaultPerms[toolName];

        if (perm === 'block') blockedCount++;
        if (perm === 'require_approval') approvalRequiredCount++;
      }

      cells.push({
        agentId: agent.id,
        serviceType: service.type,
        enabled: access?.enabled ?? false,
        credentialStatus,
        toolCount: toolNames.length,
        blockedCount,
        approvalRequiredCount,
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
  serviceType: ServiceType
): Promise<AgentServiceConfig | null> {
  // Get agent
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) return null;

  // Get service access
  const [access] = await db
    .select()
    .from(agentServiceAccess)
    .where(and(eq(agentServiceAccess.agentId, agentId), eq(agentServiceAccess.serviceType, serviceType)));

  // Get tool permission overrides
  const toolOverrides = await db
    .select()
    .from(agentToolPermissions)
    .where(and(eq(agentToolPermissions.agentId, agentId), eq(agentToolPermissions.serviceType, serviceType)));

  const overrideMap = new Map(toolOverrides.map((o) => [o.toolName, o.permission as ToolPermission]));

  // Determine credential status
  let credentialStatus: 'connected' | 'missing' | 'expired' | 'not_linked' = 'not_linked';
  if (access?.credentialId) {
    const [cred] = await db.select().from(credentials).where(eq(credentials.id, access.credentialId));
    if (!cred) {
      credentialStatus = 'missing';
    } else if (cred.expiresAt && new Date(cred.expiresAt) < new Date()) {
      credentialStatus = 'expired';
    } else {
      credentialStatus = 'connected';
    }
  }

  // Build tools list with descriptions from server manager
  const serverTools = serverManager.getAllServerTools(serviceType);
  const defaultPerms = SERVICE_METADATA[serviceType].defaultPermissions;

  const tools: ToolPermissionEntry[] = [];

  // Use server tools if available, otherwise fall back to defaults
  const toolNames = serverTools.length > 0
    ? serverTools.map((t) => t.name)
    : Object.keys(defaultPerms);

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
    serviceName: SERVICE_METADATA[serviceType].name,
    enabled: access?.enabled ?? false,
    credentialId: access?.credentialId ?? null,
    credentialStatus,
    tools,
  };
}

/**
 * Enable or disable a service for an agent
 */
export async function setServiceAccess(
  agentId: string,
  serviceType: ServiceType,
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
  serviceType: ServiceType,
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
export async function unlinkCredential(agentId: string, serviceType: ServiceType): Promise<void> {
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
  serviceType: ServiceType,
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
  serviceType: ServiceType,
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
  serviceType: ServiceType,
  permissions: Record<string, ToolPermission>
): Promise<void> {
  for (const [toolName, permission] of Object.entries(permissions)) {
    await setToolPermission(agentId, serviceType, toolName, permission);
  }
}

/**
 * Get effective permissions for an agent's service (for policy engine integration)
 */
export async function getEffectivePermissions(
  agentId: string,
  serviceType: ServiceType
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

  const defaultPerms = SERVICE_METADATA[serviceType].defaultPermissions;
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
  serviceType: ServiceType,
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
  serviceType: ServiceType
): Promise<Array<{ id: string; type: string; status: string; expiresAt: string | null }>> {
  const creds = await db.select().from(credentials).where(eq(credentials.serviceId, serviceType));

  return creds.map((c) => {
    let status = 'valid';
    if (c.expiresAt && new Date(c.expiresAt) < new Date()) {
      status = 'expired';
    }
    return {
      id: c.id,
      type: c.type,
      status,
      expiresAt: c.expiresAt,
    };
  });
}
