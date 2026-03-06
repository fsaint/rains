/**
 * Permission Service
 *
 * Manages granular per-agent, per-service, per-tool permissions.
 */

import { db } from '../db/index.js';
import { agentServiceAccess, agentToolPermissions, agents, credentials } from '../db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { serverManager } from '../mcp/server-manager.js';

export type ServiceType = 'gmail' | 'drive' | 'calendar' | 'web-search' | 'browser';
export type ToolPermission = 'allow' | 'block' | 'require_approval';
export type PermissionLevel = 'none' | 'read' | 'full' | 'custom';

/**
 * Permission presets define tool categorization for each service.
 * - read: Tools allowed in read-only mode
 * - write: Tools requiring approval in full mode
 * - blocked: Always blocked (destructive actions)
 */
export const PERMISSION_PRESETS: Record<ServiceType, {
  read: string[];
  write: string[];
  blocked: string[];
}> = {
  gmail: {
    read: ['gmail_list_messages', 'gmail_get_message', 'gmail_search', 'gmail_list_labels'],
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
  permissionLevel: PermissionLevel;
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
 * Calculate permission level from tool permissions (synchronous helper)
 */
function calculatePermissionLevelFromTools(
  serviceType: ServiceType,
  tools: Record<string, ToolPermission>
): PermissionLevel {
  const preset = PERMISSION_PRESETS[serviceType];

  // Check if all read tools are allowed
  const readToolsAllowed = preset.read.every((tool) => tools[tool] === 'allow');

  // Check if all blocked tools are blocked
  const blockedToolsBlocked = preset.blocked.every((tool) => tools[tool] === 'block');

  // Check write tools
  const writeToolsBlocked = preset.write.length === 0 || preset.write.every((tool) => tools[tool] === 'block');
  const writeToolsApproval = preset.write.length === 0 || preset.write.every((tool) => tools[tool] === 'require_approval');

  if (!blockedToolsBlocked) {
    return 'custom';
  }

  if (!readToolsAllowed) {
    return 'custom';
  }

  if (writeToolsBlocked) {
    return 'read';
  }

  if (writeToolsApproval) {
    return 'full';
  }

  return 'custom';
}

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

      // Build effective permissions map for level calculation
      const effectiveTools: Record<string, ToolPermission> = {};

      for (const toolName of toolNames) {
        const override = agentToolPerms.find((p) => p.toolName === toolName);
        const perm = override ? (override.permission as ToolPermission) : defaultPerms[toolName];
        effectiveTools[toolName] = perm;

        if (perm === 'block') blockedCount++;
        if (perm === 'require_approval') approvalRequiredCount++;
      }

      // Calculate permission level
      let permissionLevel: PermissionLevel = 'none';
      if (access?.enabled) {
        permissionLevel = calculatePermissionLevelFromTools(service.type, effectiveTools);
      }

      cells.push({
        agentId: agent.id,
        serviceType: service.type,
        enabled: access?.enabled ?? false,
        credentialStatus,
        toolCount: toolNames.length,
        blockedCount,
        approvalRequiredCount,
        permissionLevel,
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
): Promise<Array<{
  id: string;
  type: string;
  status: string;
  expiresAt: string | null;
  accountEmail: string | null;
  accountName: string | null;
}>> {
  // For Google services (gmail, drive, calendar), also match credentials with serviceId='google'
  const googleServices = ['gmail', 'drive', 'calendar'];
  const serviceIds = googleServices.includes(serviceType)
    ? [serviceType, 'google']
    : [serviceType];
  const creds = await db.select().from(credentials).where(inArray(credentials.serviceId, serviceIds));

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
      accountEmail: c.accountEmail,
      accountName: c.accountName,
    };
  });
}

/**
 * Set permission level for an agent's service.
 * This bulk-updates tool permissions based on the selected level:
 * - 'none': Disables the service entirely
 * - 'read': Read tools allowed, write and blocked tools blocked
 * - 'full': Read tools allowed, write tools require approval, blocked tools blocked
 */
export async function setPermissionLevel(
  agentId: string,
  serviceType: ServiceType,
  level: PermissionLevel
): Promise<void> {
  if (level === 'custom') {
    // 'custom' is read-only - cannot set directly
    throw new Error("Cannot set permission level to 'custom'. Use individual tool permissions instead.");
  }

  if (level === 'none') {
    // Disable the service
    await setServiceAccess(agentId, serviceType, false);
    return;
  }

  // Enable the service
  await setServiceAccess(agentId, serviceType, true);

  const preset = PERMISSION_PRESETS[serviceType];
  const permissions: Record<string, ToolPermission> = {};

  // Configure read tools - always allowed when enabled
  for (const tool of preset.read) {
    permissions[tool] = 'allow';
  }

  // Configure write tools based on level
  for (const tool of preset.write) {
    if (level === 'read') {
      permissions[tool] = 'block';
    } else {
      // 'full' - write tools require approval
      permissions[tool] = 'require_approval';
    }
  }

  // Configure blocked tools - always blocked
  for (const tool of preset.blocked) {
    permissions[tool] = 'block';
  }

  // Apply all permissions
  await setServiceToolPermissions(agentId, serviceType, permissions);
}

/**
 * Get the current permission level for an agent's service.
 * Returns 'custom' if tool permissions don't match any preset.
 */
export async function getPermissionLevel(
  agentId: string,
  serviceType: ServiceType
): Promise<PermissionLevel> {
  const { enabled, tools } = await getEffectivePermissions(agentId, serviceType);

  if (!enabled) {
    return 'none';
  }

  const preset = PERMISSION_PRESETS[serviceType];

  // Check if all read tools are allowed
  const readToolsAllowed = preset.read.every((tool) => tools[tool] === 'allow');

  // Check if all blocked tools are blocked
  const blockedToolsBlocked = preset.blocked.every((tool) => tools[tool] === 'block');

  // Check write tools
  const writeToolsBlocked = preset.write.every((tool) => tools[tool] === 'block');
  const writeToolsApproval = preset.write.every((tool) => tools[tool] === 'require_approval');

  if (!blockedToolsBlocked) {
    // If any blocked tool is not blocked, it's custom
    return 'custom';
  }

  if (!readToolsAllowed) {
    // If any read tool is not allowed, it's custom
    return 'custom';
  }

  if (writeToolsBlocked) {
    return 'read';
  }

  if (writeToolsApproval) {
    return 'full';
  }

  // Mixed write tool permissions = custom
  return 'custom';
}
