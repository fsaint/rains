/**
 * Permission Service
 *
 * Manages granular per-agent, per-service, per-tool permissions.
 * Service metadata is read from the @reins/servers registry — no hardcoding.
 */

import { db, client } from '../db/index.js';
import { agentServiceAccess, agentToolPermissions, agentServiceCredentials, agentServiceInstances, agents, credentials, deployedAgents } from '../db/schema.js';
import { eq, and, inArray, isNull } from 'drizzle-orm';
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
function getDefaultPermsFromDef(def: { permissions: { read: string[]; write: string[]; blocked: string[]; defaultWritePermission?: 'allow' | 'require_approval' } }): Record<string, ToolPermission> {
  const result: Record<string, ToolPermission> = {};
  const defaultWrite = def.permissions.defaultWritePermission ?? 'require_approval';
  for (const tool of def.permissions.read) result[tool] = 'allow';
  for (const tool of def.permissions.write) result[tool] = defaultWrite;
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
  const writeToolsAllowed = preset.write.length === 0 || preset.write.every((tool) => tools[tool] === 'allow');

  if (!blockedToolsBlocked) return 'custom';
  if (!readToolsAllowed) return 'custom';
  if (writeToolsBlocked) return 'read';
  if (writeToolsApproval || writeToolsAllowed) return 'full';
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
      // Every branch above assigns connected/expired/missing, so the old
      // not_linked guard and its cast were both unreachable.
      status: credentialStatus,
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

/** The service that can change what other agents are allowed to do. */
export const ADMIN_SERVICE_TYPE = 'helm-admin';

/**
 * What an admin agent may hold alongside helm-admin.
 *
 * Memory only, and the reason is narrow: a memory scope belongs to one agent and
 * stores no outside credential, so it cannot be turned into a route to the
 * owner's mail or files. Anything holding a credential could be, which is the
 * whole point of keeping this agent alone.
 */
export const ADMIN_COMPATIBLE_SERVICES = new Set(['memory']);

/** An agent anyone can drive, because its MCP endpoint takes no credential. */
export interface OpenMcpAgent {
  id: string;
  name: string;
}

/** Thrown when the account is not closed enough to hold an admin agent. */
export class UnauthenticatedEndpointsOpenError extends Error {
  readonly code = 'UNAUTHENTICATED_ENDPOINTS_OPEN';
  constructor(
    message: string,
    readonly openAgents: OpenMcpAgent[]
  ) {
    super(message);
    this.name = 'UnauthenticatedEndpointsOpenError';
  }
}

/**
 * The owner's agents that still answer MCP calls without a token.
 *
 * Mirrors authenticateMcp in api/routes.ts, and the two cases have to match or
 * this reports safe while the endpoint serves: it takes the most recent live
 * deployment row, and treats **no live row at all** as open, because that is
 * what the gate does before handing off to handleMCPRequest. Reading only
 * allow_unauthenticated = true would miss every agent that has never deployed.
 */
export async function listOpenMcpAgents(userId: string): Promise<OpenMcpAgent[]> {
  const result = await client.execute({
    sql: `SELECT a.id, a.name
          FROM agents a
          LEFT JOIN LATERAL (
            SELECT da.allow_unauthenticated
            FROM deployed_agents da
            WHERE da.agent_id = a.id AND da.status NOT IN ('destroyed', 'error')
            ORDER BY da.created_at DESC
            LIMIT 1
          ) d ON true
          WHERE a.user_id = ?
            AND (d.allow_unauthenticated IS NULL OR d.allow_unauthenticated = true)
          ORDER BY a.name`,
    args: [userId],
  });
  return result.rows.map((row) => ({ id: row.id as string, name: row.name as string }));
}

/** Does this owner already have an agent holding helm-admin? */
export async function userHasAdminAgent(userId: string): Promise<boolean> {
  const result = await client.execute({
    sql: `SELECT 1
          FROM agents a
          WHERE a.user_id = ?
            AND (
              EXISTS (SELECT 1 FROM agent_service_instances i
                      WHERE i.agent_id = a.id AND i.service_type = ? AND i.enabled = true)
              OR EXISTS (SELECT 1 FROM agent_service_access s
                         WHERE s.agent_id = a.id AND s.service_type = ? AND s.enabled = true)
            )
          LIMIT 1`,
    args: [userId, ADMIN_SERVICE_TYPE, ADMIN_SERVICE_TYPE],
  });
  return result.rows.length > 0;
}

/**
 * Refuse to create an admin agent while any of the owner's agents can be driven
 * by anyone holding its id.
 *
 * Without this the exclusivity rule is decorative: an admin agent grants Gmail
 * to agent B, reads B's id from its own list_agents output, and POSTs to
 * /mcp/<B>. Keeping the admin agent poor means nothing if every other agent on
 * the account is an open door.
 */
export async function assertNoOpenMcpEndpoints(userId: string): Promise<void> {
  const open = await listOpenMcpAgents(userId);
  if (open.length === 0) return;

  const names = open.map((a) => a.name).join(', ');
  throw new UnauthenticatedEndpointsOpenError(
    `Cannot enable Helm Admin: ${open.length} agent${open.length === 1 ? '' : 's'} still accept unauthenticated MCP calls (${names}). ` +
      `An admin agent could grant them access and then use them directly. Close their unauthenticated endpoints, then enable this again.`,
    open
  );
}

/** Thrown by assertServiceCombinationAllowed. Carries what blocked the write. */
export class ServiceCombinationError extends Error {
  readonly code = 'SERVICE_COMBINATION_NOT_ALLOWED';
  constructor(
    message: string,
    readonly serviceType: string,
    readonly conflicting: string[]
  ) {
    super(message);
    this.name = 'ServiceCombinationError';
  }
}

/**
 * Every service type currently live on an agent.
 *
 * Per type this answers exactly what isServiceEnabledForAgent answers — an
 * enabled instance row, or failing that an enabled legacy access row — so a
 * service that is invisible to one and live on the other cannot slip past the
 * guard below. Kept as a union rather than a per-type loop so adding a service
 * does not add a query.
 */
export async function listEnabledServiceTypes(agentId: string): Promise<string[]> {
  const instances = await db
    .select({ serviceType: agentServiceInstances.serviceType })
    .from(agentServiceInstances)
    .where(and(eq(agentServiceInstances.agentId, agentId), eq(agentServiceInstances.enabled, true)));

  const legacy = await db
    .select({ serviceType: agentServiceAccess.serviceType })
    .from(agentServiceAccess)
    .where(and(eq(agentServiceAccess.agentId, agentId), eq(agentServiceAccess.enabled, true)));

  return [...new Set([...instances, ...legacy].map((r) => r.serviceType))];
}

/**
 * Refuse service combinations that would let an agent grant itself capability.
 *
 * helm-admin can change any agent's permissions, including its own. An agent
 * holding it plus Gmail is not an agent with two services — it is an agent with
 * every service, reachable in two steps. So the two are mutually exclusive, and
 * the check runs in both directions because either order produces the same pair.
 *
 * This lives here rather than in the MCP server so it binds every caller: the
 * dashboard, the admin MCP itself, and anything added later. Callers that reach
 * around it by writing agent_service_access or agent_service_instances directly
 * would defeat it — use setServiceAccess/createServiceInstance.
 */
export async function assertServiceCombinationAllowed(
  agentId: string,
  serviceType: string
): Promise<void> {
  const enabled = await listEnabledServiceTypes(agentId);

  if (serviceType === ADMIN_SERVICE_TYPE) {
    const conflicting = enabled.filter(
      (s) => s !== ADMIN_SERVICE_TYPE && !ADMIN_COMPATIBLE_SERVICES.has(s)
    );
    if (conflicting.length > 0) {
      throw new ServiceCombinationError(
        `An admin agent can hold only memory alongside Helm Admin. This agent also has: ${conflicting.join(', ')}.`,
        serviceType,
        conflicting
      );
    }

    // Already enabled — re-enabling is a no-op and must stay idempotent, so it
    // does not get re-blocked by an account state it did not change.
    if (enabled.includes(ADMIN_SERVICE_TYPE)) return;

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (agent?.userId) await assertNoOpenMcpEndpoints(agent.userId);
    return;
  }

  if (ADMIN_COMPATIBLE_SERVICES.has(serviceType)) return;

  if (enabled.includes(ADMIN_SERVICE_TYPE)) {
    throw new ServiceCombinationError(
      `This agent has Helm Admin, which can change what every agent is allowed to do. Adding ${serviceType} to it would let it grant itself access to your data. Use a separate agent.`,
      serviceType,
      [ADMIN_SERVICE_TYPE]
    );
  }
}

/**
 * Enable or disable a service for an agent
 */
export async function setServiceAccess(
  agentId: string,
  serviceType: string,
  enabled: boolean
): Promise<void> {
  // Only enabling can create a forbidden pair; disabling always shrinks the set.
  if (enabled) await assertServiceCombinationAllowed(agentId, serviceType);

  const now = new Date().toISOString();

  await client.execute({
    sql: `INSERT INTO agent_service_access (id, agent_id, service_type, enabled, credential_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, NULL, ?, ?)
          ON CONFLICT (agent_id, service_type)
          DO UPDATE SET enabled = ?, updated_at = ?`,
    args: [nanoid(), agentId, serviceType, enabled, now, now, enabled, now],
  });
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
 * Auto-link a credential to the owner's agents that have the service enabled
 * but no usable credential. Updates both the legacy agent_service_access table
 * and any instance-based entries.
 *
 * "No usable credential" means either no credential id at all, or an id whose
 * credentials row is gone. The Credentials page "Update" flow deletes and
 * recreates a credential, and until detachCredential existed the instance kept
 * the dead id; a null-only check skipped exactly the instances that needed
 * the new one.
 *
 * Scoped to the credential's owner on purpose. Instances of this service are
 * read across every account, and an unscoped fill would attach one user's
 * inbox, drive, or meeting archive to another user's agent — a cross-tenant
 * leak. A credential with no user_id (legacy rows) keeps the old unscoped
 * behaviour, since there is no owner to scope to.
 */
export async function autoLinkCredential(serviceType: string, credentialId: string): Promise<void> {
  const rows = await db
    .select()
    .from(agentServiceAccess)
    .where(and(eq(agentServiceAccess.serviceType, serviceType), eq(agentServiceAccess.enabled, true)));

  const instances = await db
    .select()
    .from(agentServiceInstances)
    .where(and(eq(agentServiceInstances.serviceType, serviceType), eq(agentServiceInstances.enabled, true)));

  // One credentials read: the credential being linked (for its owner) plus
  // every id the rows reference (to tell a live link from a dangling one).
  const referenced = new Set<string>([credentialId]);
  for (const r of [...rows, ...instances]) if (r.credentialId) referenced.add(r.credentialId);
  const liveCredentials = await db
    .select()
    .from(credentials)
    .where(inArray(credentials.id, [...referenced]));
  const live = new Set(liveCredentials.map((c) => c.id));
  const ownerId = liveCredentials.find((c) => c.id === credentialId)?.userId ?? null;

  let ownerAgentIds: Set<string> | null = null;
  if (ownerId) {
    const ownerAgents = await db.select().from(agents).where(eq(agents.userId, ownerId));
    ownerAgentIds = new Set(ownerAgents.filter((a) => a.userId === ownerId).map((a) => a.id));
  }
  const belongsToOwner = (agentId: string) => ownerAgentIds === null || ownerAgentIds.has(agentId);
  const unusable = (id: string | null) => !id || !live.has(id);

  for (const row of rows) {
    if (belongsToOwner(row.agentId) && unusable(row.credentialId)) {
      await linkCredential(row.agentId, serviceType, credentialId);
    }
  }

  for (const inst of instances) {
    if (belongsToOwner(inst.agentId) && unusable(inst.credentialId)) {
      await db
        .update(agentServiceInstances)
        .set({ credentialId, updatedAt: new Date().toISOString() })
        .where(eq(agentServiceInstances.id, inst.id));
    }
  }
}

/**
 * Remove every reference to a credential that is being deleted.
 *
 * The credentials table has no foreign keys pointing back at it, so a vault
 * delete on its own leaves instances, the legacy access rows and the junction
 * table holding the dead id. Such an instance shows as 'missing', hands the
 * dead id to the dashboard, and gives tool calls no token. Call this right
 * after a successful vault delete.
 */
export async function detachCredential(credentialId: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(agentServiceInstances)
    .set({ credentialId: null, updatedAt: now })
    .where(eq(agentServiceInstances.credentialId, credentialId));
  await db
    .delete(agentServiceCredentials)
    .where(eq(agentServiceCredentials.credentialId, credentialId));
  await db
    .update(agentServiceAccess)
    .set({ credentialId: null, updatedAt: now })
    .where(eq(agentServiceAccess.credentialId, credentialId));
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
  // Only the agent-level row (no instance). With several instances of one
  // service, a lookup by (agent, service, tool) alone would land on whichever
  // sibling's row sorts first and overwrite that account's setting.
  const [existing] = await db
    .select()
    .from(agentToolPermissions)
    .where(
      and(
        eq(agentToolPermissions.agentId, agentId),
        eq(agentToolPermissions.serviceType, serviceType),
        eq(agentToolPermissions.toolName, toolName),
        isNull(agentToolPermissions.instanceId)
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
 * Is `serviceType` enabled on this agent?
 *
 * The single definition of the enablement boundary. Both the MCP endpoint and the
 * gateway-token HTTP routes answer it through here — if they ever drift, a tool
 * blocked over MCP becomes reachable over plain HTTP with the agent's own token.
 *
 * An enabled instance row is the modern answer; agents predating instances fall
 * back to the legacy per-service access row.
 */
export async function isServiceEnabledForAgent(
  agentId: string,
  serviceType: string
): Promise<boolean> {
  const instances = await db
    .select()
    .from(agentServiceInstances)
    .where(and(
      eq(agentServiceInstances.agentId, agentId),
      eq(agentServiceInstances.serviceType, serviceType),
      eq(agentServiceInstances.enabled, true)
    ));

  if (instances.length > 0) return true;

  const { enabled } = await getEffectivePermissions(agentId, serviceType);
  return enabled;
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
    // Instance rows too, or this does not turn the service off. Enablement is
    // "an enabled instance, or failing that an enabled access row", so clearing
    // only the access row leaves an instance-based agent — which is every agent
    // created since instances landed — still holding the service, while the
    // call reports success. Found by disabling a service and watching it stay on.
    await db
      .update(agentServiceInstances)
      .set({ enabled: false, updatedAt: new Date().toISOString() })
      .where(and(
        eq(agentServiceInstances.agentId, agentId),
        eq(agentServiceInstances.serviceType, serviceType)
      ));
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
    permissions[tool] = level === 'read' ? 'block' : (def.permissions.defaultWritePermission ?? 'require_approval');
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

/**
 * Decode the `config` column of an instance row.
 *
 * Anything that is not a JSON object — null, empty, malformed, an array, a
 * scalar — reads as "no config". A handler must never see a half-parsed value,
 * and a bad row must not take the whole instance list down with it.
 */
export function parseInstanceConfig(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export interface ServiceInstance {
  id: string;
  agentId: string;
  serviceType: string;
  serviceName: string;
  label: string | null;
  /** Per-instance settings, or null. Shape is owned by the service. */
  config: Record<string, unknown> | null;
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
    telegramBotUsername?: string | null;
  }>;
  availableServices: Array<{ type: string; name: string; icon: string; authRequired: boolean }>;
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
  credentialId?: string,
  config?: Record<string, unknown> | null
): Promise<{ instance: ServiceInstance; created: boolean }> {
  const registry = await getRegistry();
  const def = registry.serviceRegistry.get(serviceType);
  if (!def) throw new Error(`Unknown service type: ${serviceType}`);

  // Before the insert, not after. This function writes the instance row and
  // only then calls setServiceAccess, so relying on the guard inside that would
  // reject the write with the instance row already committed — the agent would
  // show the service in tools/list while the access row said no.
  await assertServiceCombinationAllowed(agentId, serviceType);

  const existing = await db
    .select()
    .from(agentServiceInstances)
    .where(and(eq(agentServiceInstances.agentId, agentId), eq(agentServiceInstances.serviceType, serviceType)));

  // Idempotency is keyed on the *account*, not the service type. An agent may
  // hold several accounts of one service (two Gmail inboxes), each as its own
  // instance — so only two adds are no-ops: one that names an account already
  // attached, and one that names no account at all (memory, skills, helm-admin
  // and other credential-less services, whose callers retry). Both return the
  // existing row with `created: false` so the route skips the redeploy.
  const asExisting = async (id: string) =>
    ({ instance: (await getInstanceById(id)) as ServiceInstance, created: false });

  let resolvedCredentialId = credentialId ?? null;
  if (!resolvedCredentialId && existing.length > 0) return asExisting(existing[0].id);

  const now = new Date().toISOString();

  // If no credential was explicitly provided, find the first matching one for this agent's user.
  // This handles the common case where the credential already exists when the service is added.
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

  if (resolvedCredentialId) {
    const same = existing.find((i) => i.credentialId === resolvedCredentialId);
    if (same) return asExisting(same.id);

    // An instance created before its account was connected (or whose auto-link
    // never ran) sits with no credential. Attach to it rather than leaving it
    // unlinked beside a new sibling — the same repair autoLinkCredential makes.
    const unlinked = existing.find((i) => !i.credentialId);
    if (unlinked) {
      await db
        .update(agentServiceInstances)
        .set({ credentialId: resolvedCredentialId, updatedAt: now })
        .where(eq(agentServiceInstances.id, unlinked.id));
      try {
        await addServiceCredential(agentId, serviceType, resolvedCredentialId, unlinked.isDefault);
      } catch {
        // May already exist
      }
      return asExisting(unlinked.id);
    }
  }

  const isDefault = existing.length === 0;
  const id = nanoid();

  await db.insert(agentServiceInstances).values({
    id,
    agentId,
    serviceType,
    label: label ?? null,
    credentialId: resolvedCredentialId,
    enabled: true,
    isDefault,
    config: config ? JSON.stringify(config) : null,
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

  return { instance: (await getInstanceById(id)) as ServiceInstance, created: true };
}

/**
 * Enable services that are on by default for every new agent (memory, skills).
 * Idempotent — safe to call multiple times; will not create duplicate instances.
 */
export async function enableDefaultServices(agentId: string): Promise<void> {
  const defaults = ['memory', 'skills'];
  for (const serviceType of defaults) {
    try {
      const existing = await db
        .select()
        .from(agentServiceInstances)
        .where(and(eq(agentServiceInstances.agentId, agentId), eq(agentServiceInstances.serviceType, serviceType)))
        .limit(1);
      if (existing.length > 0) continue;
      await createServiceInstance(agentId, serviceType);
    } catch (err) {
      console.warn(`[enableDefaultServices] failed to enable ${serviceType} for agent ${agentId}:`, err instanceof Error ? err.message : err);
    }
  }
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

  // What is left of this service on the agent. The deleted row is excluded
  // explicitly rather than trusted to be gone, so the decision below cannot
  // be fooled by a read that races the delete.
  const remaining = (
    await db
      .select()
      .from(agentServiceInstances)
      .where(and(eq(agentServiceInstances.agentId, instance.agentId), eq(agentServiceInstances.serviceType, instance.serviceType)))
  ).filter((i) => i.id !== instanceId);

  // If it was the default, promote the next one
  if (instance.isDefault && remaining.length > 0) {
    await db
      .update(agentServiceInstances)
      .set({ isDefault: true, updatedAt: new Date().toISOString() })
      .where(eq(agentServiceInstances.id, remaining[0].id));
  }

  // The legacy agent_service_access row is the other record of "this service
  // is on", and createServiceInstance enabled it. listEnabledServiceTypes
  // unions both tables, so if it stayed enabled the service would keep
  // counting — for the combination guard and the dashboard — with nothing
  // left to remove.
  if (remaining.length === 0) {
    await setServiceAccess(instance.agentId, instance.serviceType, false);
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
  updates: { label?: string; credentialId?: string; enabled?: boolean; config?: Record<string, unknown> | null }
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
  // Omitted leaves the config alone; null clears it.
  if (updates.config !== undefined) setValues.config = updates.config ? JSON.stringify(updates.config) : null;

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
    const needsCredential = def?.auth.required ?? true;
    const credInfo = needsCredential
      ? await getCredentialStatus(inst.credentialId)
      : { status: 'connected' as const, email: null, name: null };
    const { permissionLevel, toolCount, blockedCount, approvalRequiredCount } = await getInstancePermissionSummary(inst.id, inst.agentId, inst.serviceType);

    results.push({
      id: inst.id,
      agentId: inst.agentId,
      serviceType: inst.serviceType,
      serviceName: def?.name ?? inst.serviceType,
      label: inst.label,
      config: parseInstanceConfig(inst.config),
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
    config: parseInstanceConfig(inst.config),
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
// ============================================================================
// Drive Path-Based Permissions
// ============================================================================

export interface DrivePathRuleEntry {
  folderId: string;
  label?: string;
  permission: 'read' | 'write' | 'blocked';
}

export interface DrivePathConfig {
  defaultLevel: 'read' | 'write' | 'blocked';
  rules: DrivePathRuleEntry[];
}

/**
 * Get the Drive path-based permission config for an agent.
 */
export async function getDrivePathConfig(agentId: string): Promise<DrivePathConfig> {
  const rows = await db
    .select({ pathRules: agentServiceAccess.pathRules })
    .from(agentServiceAccess)
    .where(and(eq(agentServiceAccess.agentId, agentId), eq(agentServiceAccess.serviceType, 'drive')));

  const raw = rows[0]?.pathRules;
  if (!raw) {
    return { defaultLevel: 'write', rules: [] };
  }

  try {
    return JSON.parse(raw) as DrivePathConfig;
  } catch {
    return { defaultLevel: 'write', rules: [] };
  }
}

/**
 * Set the Drive path-based permission config for an agent.
 * Creates the access row if it doesn't exist.
 */
export async function setDrivePathConfig(agentId: string, config: DrivePathConfig): Promise<void> {
  const json = JSON.stringify(config);
  const existing = await db
    .select({ id: agentServiceAccess.id })
    .from(agentServiceAccess)
    .where(and(eq(agentServiceAccess.agentId, agentId), eq(agentServiceAccess.serviceType, 'drive')));

  if (existing.length > 0) {
    await db
      .update(agentServiceAccess)
      .set({ pathRules: json, updatedAt: new Date().toISOString() })
      .where(and(eq(agentServiceAccess.agentId, agentId), eq(agentServiceAccess.serviceType, 'drive')));
  } else {
    await db.insert(agentServiceAccess).values({
      id: nanoid(),
      agentId,
      serviceType: 'drive',
      enabled: true,
      pathRules: json,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
}

export async function getAgentPermissions(userId?: string): Promise<AgentPermissionsResponse> {
  const registry = await getRegistry();
  const allAgents = userId
    ? await db.select().from(agents).where(eq(agents.userId, userId))
    : await db.select().from(agents);

  const agentResults: AgentPermissionsResponse['agents'] = [];
  for (const agent of allAgents) {
    const [instances, deployments] = await Promise.all([
      getAgentInstances(agent.id),
      db.select({ telegramBotUsername: deployedAgents.telegramBotUsername })
        .from(deployedAgents)
        .where(and(eq(deployedAgents.agentId, agent.id)))
        .limit(1),
    ]);
    agentResults.push({
      id: agent.id,
      name: agent.name,
      status: agent.status,
      instances,
      telegramBotUsername: deployments[0]?.telegramBotUsername ?? null,
    });
  }

  const availableServices = registry.serviceDefinitions.map((def) => ({
    type: def.type,
    name: def.name,
    icon: def.type,
    authRequired: def.auth.required,
  }));

  return { agents: agentResults, availableServices };
}
