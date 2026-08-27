/**
 * MCP Agent Endpoint Handler
 *
 * Implements JSON-RPC 2.0 protocol for MCP tool discovery and execution.
 * Aggregates tools from all enabled services, filters based on agent permissions,
 * and routes tool calls with permission checking and approval workflows.
 */

import { db, client } from '../db/index.js';
import { agents, agentServiceAccess, agentServiceCredentials, agentServiceInstances, credentials } from '../db/schema.js';
import { updateMachineEnv } from '../providers/fly.js';
import { eq, and, inArray } from 'drizzle-orm';
import { serverManager, type ToolContext } from './server-manager.js';
import {
  getEffectivePermissions,
  getEffectiveInstancePermissions,
  canAccessTool,
  getDrivePathConfig,
  type ToolPermission,
} from '../services/permissions.js';
import { approvalQueue, MAX_REVISIONS } from '../approvals/queue.js';
import { auditLogger } from '../audit/logger.js';
import { credentialVault } from '../credentials/vault.js';
import { sendReauthEmail } from '../services/email.js';
import { config } from '../config/index.js';
import { getPostHog } from '../analytics/posthog.js';
import type { DeferredJobResult } from '@reins/shared';
import {
  MCP_SERVER_NAME,
  LEGACY_MCP_SERVER_NAME,
  BUILTIN_TOOLS,
  canonicalToolName,
  modelVisibleToolName,
  resolveToolTokens,
  resolveSkillTokens,
  type AgentRuntime,
} from '@reins/shared';

import { checkSpendCap } from '../services/spend.js';
import { checkUsageGate } from '../services/billing.js';
import {
  parseRequiredServices,
  buildSetupNotice,
  loadSkillVersionManifest,
} from '../services/skills.js';

/**
 * Read an agent's runtime off a deployed_agents row.
 *
 * The column predates Hermes, so legacy rows are null — which means openclaw.
 * The runtime decides how tool names are rendered back to the model, and the
 * two runtimes disagree, so guessing here produces names the model cannot call.
 */
function runtimeOf(row: { runtime?: unknown } | undefined): AgentRuntime {
  return row?.runtime === 'hermes' ? 'hermes' : 'openclaw';
}

/**
 * The MCP server name this agent's machine was actually deployed with.
 *
 * NOT MCP_SERVER_NAME: that constant moves the moment the backend deploys,
 * while the agent keeps the prefix baked into its MCP_CONFIG until it is
 * redeployed. Naming tools with the constant during that window points the
 * model at a tool it does not have.
 */
function serverNameOf(row: { mcp_server_name?: unknown } | undefined): string {
  const name = row?.mcp_server_name;
  return typeof name === 'string' && name.length > 0 ? name : LEGACY_MCP_SERVER_NAME;
}

/** Look up how to address tools for an agent, when no deployment row is in hand. */
async function getAgentToolNaming(
  agentId: string
): Promise<{ runtime: AgentRuntime; serverName: string }> {
  const row = await client.execute({
    sql: `SELECT runtime, mcp_server_name FROM deployed_agents WHERE agent_id = ? AND status NOT IN ('destroyed', 'error') ORDER BY created_at DESC LIMIT 1`,
    args: [agentId],
  });
  return { runtime: runtimeOf(row.rows[0]), serverName: serverNameOf(row.rows[0]) };
}

// ============================================================================
// Types
// ============================================================================

export interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
    protocolVersion?: string;
    capabilities?: Record<string, unknown>;
    clientInfo?: { name: string; version: string };
    [key: string]: unknown;
  };
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface MCPToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ============================================================================
// Error Codes
// ============================================================================

export const MCP_ERROR_CODES = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  TOOL_BLOCKED: -32001,
  AGENT_NOT_FOUND: -32002,
  SERVICE_NOT_ENABLED: -32003,
  APPROVAL_DENIED: -32004,
  MISSING_CREDENTIALS: -32005,
} as const;

interface ToolExecutionResult {
  success: boolean;
  data?: unknown;
  /** True when the tool ran but returned an error result (MCP isError: true) */
  isToolError?: boolean;
  /** For JSON-RPC protocol errors (credential/auth problems) */
  errorCode?: number;
  errorMessage?: string;
  errorData?: Record<string, unknown>;
}

// ============================================================================
// Service Type Mapping (loaded from registry)
// ============================================================================

let _registryLoaded = false;
let _serviceTypes: string[] = [];
let _getServiceType: (toolName: string) => string | null = () => null;

async function ensureRegistry() {
  if (_registryLoaded) return;
  try {
    const { serviceDefinitions, getServiceTypeFromToolName } = await import('@reins/servers');
    _serviceTypes = serviceDefinitions.map((d) => d.type);
    _getServiceType = getServiceTypeFromToolName;
  } catch {
    // Registry not available, use empty
  }
  _registryLoaded = true;
}

/**
 * Determine service type from tool name prefix
 */
export function getServiceTypeFromTool(toolName: string): string | null {
  return _getServiceType(toolName);
}

// ============================================================================
// Reauth Approval Helper
// ============================================================================

/**
 * Create (or reuse) a reauth approval when MCP credential access fails.
 * De-duplicates via submitReauth and respects the 24-hour email throttle.
 */
async function createMCPReauthApproval(
  agentId: string,
  serviceType: string,
  credentialId?: string | null,
): Promise<void> {
  const hint = `The ${serviceType} credentials for your agent have expired or are invalid. Please re-authenticate to restore access.`;

  const { id: approvalId, isNew, emailThrottled } = await approvalQueue.submitReauth(
    agentId,
    serviceType,
    hint,
    { credentialId: credentialId ?? null, source: 'mcp_tool_call' },
    7 * 24 * 60 * 60 * 1000,
  );

  if (isNew) {
    console.log(`[reauth] Created reauth approval ${approvalId} for agent ${agentId} (service: ${serviceType})`);
  } else {
    console.log(`[reauth] Reusing reauth approval ${approvalId} for agent ${agentId} (service: ${serviceType})${emailThrottled ? ' — email throttled' : ''}`);
  }

  if (!emailThrottled) {
    try {
      const agentRow = await client.execute({
        sql: `SELECT a.name, u.email FROM agents a JOIN users u ON u.id = a.user_id WHERE a.id = ?`,
        args: [agentId],
      });
      if (agentRow.rows.length > 0) {
        const { name: agentName, email } = agentRow.rows[0] as { name: string; email: string };
        await sendReauthEmail({
          to: email,
          agentName,
          provider: serviceType,
          hint,
          approvalId,
          dashboardUrl: config.dashboardUrl,
        });
        await approvalQueue.markEmailSent(approvalId);
      }
    } catch {
      // Non-fatal — email failure should not block the MCP error response
    }
  }
}

// ============================================================================
// MCP Request Handler
// ============================================================================

function pendingApprovalUserMessage(): string {
  const base = config.dashboardUrl ?? 'the Reins dashboard';
  return `The user has been asked for permission for this operation. Please check the Telegram permission request, or go to ${base}/approvals to approve.`;
}

/** The other `pending`: the user approved and the executor is still running. */
function approvedAwaitingResultMessage(): string {
  return 'The user approved this operation and it is still running. Keep polling; there is nothing for the user to do.';
}

/**
 * Main MCP request handler
 */
export async function handleMCPRequest(
  agentId: string,
  request: MCPRequest
): Promise<MCPResponse> {
  await ensureRegistry();

  // Validate JSON-RPC version
  if (request.jsonrpc !== '2.0') {
    return {
      jsonrpc: '2.0',
      id: request.id ?? null as unknown as string,
      error: {
        code: MCP_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid JSON-RPC version',
      },
    };
  }

  // Verify agent exists and is active
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: MCP_ERROR_CODES.AGENT_NOT_FOUND,
        message: 'Agent not found',
        data: { agentId },
      },
    };
  }

  if (agent.status !== 'active') {
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: MCP_ERROR_CODES.AGENT_NOT_FOUND,
        message: 'Agent is not active',
        data: { agentId, status: agent.status },
      },
    };
  }

  // Dispatch based on method
  switch (request.method) {
    case 'initialize': {
      // Echo back the client's protocol version if provided, otherwise default
      const clientVersion = request.params?.protocolVersion as string | undefined;
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: clientVersion ?? '2024-11-05',
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: MCP_SERVER_NAME,
            version: '1.0.0',
          },
        },
      };
    }

    case 'notifications/initialized':
      // Client acknowledgement — no response needed for notifications,
      // but since this is HTTP request-response we return an empty success
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {},
      };

    case 'ping':
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {},
      };

    case 'tools/list':
      return handleListTools(agentId, request.id);

    case 'tools/call':
      if (!request.params?.name) {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: MCP_ERROR_CODES.INVALID_PARAMS,
            message: 'Missing required parameter: name',
          },
        };
      }
      return handleCallTool(
        agentId,
        request.params.name,
        request.params.arguments ?? {},
        request.id
      );

    default:
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: MCP_ERROR_CODES.METHOD_NOT_FOUND,
          message: `Method not found: ${request.method}`,
        },
      };
  }
}

// ============================================================================
// tools/list Handler
// ============================================================================

/**
 * Handle tools/list request
 * Returns all visible tools for the agent across enabled service instances.
 * Deduplicates tools across instances of the same service type (show tool if ANY instance allows it).
 */
async function handleListTools(
  agentId: string,
  requestId: string | number
): Promise<MCPResponse> {
  const tools: MCPToolSchema[] = [];
  const seenTools = new Set<string>();

  // Query instances for this agent
  const instances = await db
    .select()
    .from(agentServiceInstances)
    .where(and(eq(agentServiceInstances.agentId, agentId), eq(agentServiceInstances.enabled, true)));

  if (instances.length > 0) {
    // Instance-based path: aggregate tools across enabled instances
    for (const instance of instances) {
      const { enabled, tools: toolPermissions } = await getEffectiveInstancePermissions(instance.id);
      if (!enabled) continue;

      const server = serverManager.getServer(instance.serviceType);
      if (!server) continue;

      const serverTools = server.getToolDefinitions();
      for (const tool of serverTools) {
        if (seenTools.has(tool.name)) continue;
        const permission = toolPermissions[tool.name] as ToolPermission | undefined;
        if (permission === 'allow' || permission === 'require_approval') {
          seenTools.add(tool.name);
          tools.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          });
        }
      }
    }
  } else {
    // Fallback: legacy path using agent_service_access
    for (const serviceType of _serviceTypes) {
      const { enabled, tools: toolPermissions } = await getEffectivePermissions(agentId, serviceType);
      if (!enabled) continue;

      const server = serverManager.getServer(serviceType);
      if (!server) continue;

      const serverTools = server.getToolDefinitions();
      for (const tool of serverTools) {
        const permission = toolPermissions[tool.name] as ToolPermission | undefined;
        if (permission === 'allow' || permission === 'require_approval') {
          tools.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          });
        }
      }
    }
  }

  // Always inject the built-in get_result polling tool
  tools.push({
    name: BUILTIN_TOOLS.getResult,
    description:
      'Poll for the result of a pending approval. ' +
      'CALL THIS IMMEDIATELY AND AUTOMATICALLY whenever any tool returns status=APPROVAL_PENDING. ' +
      'Do NOT respond to the user while polling — keep calling this every 3–5 seconds until ' +
      'status is "completed", "rejected" or "changes_requested". Never wait for user input between polls. ' +
      'Returns status: pending | completed | rejected | expired | changes_requested. ' +
      'When completed, includes the result of the original tool call. ' +
      'When changes_requested, the human wants the call redone differently: read the "feedback" ' +
      'field, revise the original arguments accordingly, and call the ORIGINAL tool again with the ' +
      'corrected arguments — do not ask the user for permission first and do not repeat the identical call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        jobId: {
          type: 'string',
          description: 'The jobId returned by the original deferred tool call',
        },
      },
      required: ['jobId'],
    },
  });

  // Built-in: whoami — always present. An agent has no other way to learn its
  // own id, and several tools (memory scopes, helm-admin, skill assignment)
  // take one as an argument.
  tools.push({
    name: BUILTIN_TOOLS.whoami,
    description:
      'Return the identity of the agent making this call: its Helm agent id and name. ' +
      'Use the id wherever a tool or skill asks for an agent id (memory scopes, helm-admin, skill assignment).',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  });

  // Inject mark_onboarded if this agent has not yet completed first-run setup
  const deploymentRow = await client.execute({
    sql: `SELECT id, fly_app_name, fly_machine_id, has_onboarded, runtime, mcp_server_name FROM deployed_agents WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1`,
    args: [agentId],
  });
  const deployment = deploymentRow.rows[0];
  if (deployment && !deployment.has_onboarded) {
    tools.push({
      name: BUILTIN_TOOLS.markOnboarded,
      description:
        'Signal that first-run setup is complete. Call this after finishing all initial setup tasks. ' +
        'Removes first-run instructions from future restarts.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    });
  }

  // Append this agent's skill catalog to the skills_list description.
  //
  // Filesystem SKILL.md files self-advertise because the runtime scans them and
  // puts each name + description in context. MCP-served skills get none of
  // that, so we reproduce the same progressive disclosure here: names and
  // one-liners always visible, bodies fetched on demand via skills_get.
  const skillsTool = tools.find((t) => t.name === 'skills_list');
  if (skillsTool) {
    try {
      const catalog = await buildSkillCatalog(agentId, runtimeOf(deployment), serverNameOf(deployment));
      if (catalog) skillsTool.description = `${skillsTool.description}\n\n${catalog}`;
    } catch (error) {
      // A catalog failure must never break tools/list — the tool still works,
      // it just isn't pre-advertised.
      console.warn('[agent-endpoint] skill catalog failed (non-fatal):', error instanceof Error ? error.message : error);
    }
  }

  return {
    jsonrpc: '2.0',
    id: requestId,
    result: {
      tools,
    },
  };
}

/** Cap the injected catalog so a large library can't bloat every tools/list. */
const SKILL_CATALOG_MAX = 30;
const SKILL_CATALOG_MAX_CHARS = 2000;

/**
 * Render the agent's assigned skills as a compact catalog for the
 * skills_list description. Returns null when the agent has none.
 *
 * Exported for tests.
 */
export async function buildSkillCatalog(
  agentId: string,
  runtime: AgentRuntime = 'openclaw',
  serverName: string = MCP_SERVER_NAME
): Promise<string | null> {
  const result = await client.execute({
    // Must mirror listAgentSkills in routes.ts — explicit assignment only.
    sql: `SELECT s.slug, s.name, s.description, s.required_services, s.version FROM skills s
          JOIN agent_skills ask ON ask.skill_id = s.id
          WHERE ask.agent_id = ? AND s.enabled = true
          ORDER BY s.name`,
    args: [agentId],
  });

  // Setup state is reported even with zero skills: a fresh agent has no skill
  // that could tell it setup exists, because the boot skill is what is missing.
  const setupNotice = buildSetupNotice(
    result.rows.map((row) => ({
      slug: String(row.slug),
      version: (row.version as string | null) ?? null,
    })),
    await loadSkillVersionManifest()
  );

  if (result.rows.length === 0) return setupNotice;

  const shown = result.rows.slice(0, SKILL_CATALOG_MAX);
  const lines: string[] = ['Skills currently assigned to you:'];

  for (const row of shown) {
    const requires = parseRequiredServices(row.required_services);
    const suffix = requires.length > 0 ? ` (needs: ${requires.join(', ')})` : '';
    const description = resolveSkillTokens(
      resolveToolTokens(String(row.description ?? ''), runtime, serverName),
      runtime,
      serverName
    );
    lines.push(`- ${row.slug} — ${description}${suffix}`);
  }

  const omitted = result.rows.length - shown.length;
  if (omitted > 0) lines.push(`…and ${omitted} more.`);

  // The setup notice comes out of the same budget rather than being appended
  // past it: the skill list is the expendable part, the setup state is not.
  const catalogBudget = SKILL_CATALOG_MAX_CHARS - (setupNotice ? setupNotice.length + 1 : 0);

  let catalog = lines.join('\n');
  if (catalog.length > catalogBudget) {
    catalog = `${catalog.slice(0, catalogBudget)}…\n(truncated)`;
  }

  // tools/list is typically cached per session, so the authoritative read is
  // always the live call — say so rather than let a stale list mislead.
  const footer = `Call skills_get with a slug to read the full instructions. This list may be stale; call skills_list for the authoritative version.`;
  return [catalog, footer, setupNotice].filter(Boolean).join('\n');
}

// ============================================================================
// credentialCoversService — scope guard helper
// ============================================================================

/**
 * Returns true if the credential's granted_services includes the requested
 * serviceType, or if granted_services is null/empty (backward compatibility).
 */
async function credentialCoversService(credentialId: string, serviceType: string): Promise<boolean> {
  const [row] = await db
    .select({ grantedServices: credentials.grantedServices })
    .from(credentials)
    .where(eq(credentials.id, credentialId));
  if (!row?.grantedServices) return true;
  let scopes: string[];
  try {
    scopes = JSON.parse(row.grantedServices);
    if (!Array.isArray(scopes)) return true;
  } catch {
    return true;
  }
  return scopes.includes(serviceType);
}

// ============================================================================
// executeTool — credential resolution + tool invocation
// ============================================================================

/**
 * Resolve credentials and call the tool on the downstream MCP server.
 * Returns a ToolExecutionResult so the caller can map it to either a
 * JSON-RPC error or a tools/call result.
 */
async function executeTool(
  agentId: string,
  serviceType: string,
  toolName: string,
  argsIn: Record<string, unknown>,
  hasInstances: boolean,
  serviceInstances: (typeof agentServiceInstances.$inferSelect)[],
): Promise<ToolExecutionResult> {
  let args = { ...argsIn };

  // If gmail_send_draft is called with a draftId that is actually an approval jobId
  // (the model used the jobId from gmail_create_draft's APPROVAL_PENDING response instead
  // of waiting for the real Gmail draft ID), resolve the real draftId from the stored result.
  if (toolName === 'gmail_send_draft' && typeof args.draftId === 'string') {
    const relatedApproval = await approvalQueue.get(args.draftId);
    if (relatedApproval?.tool === 'gmail_create_draft' && relatedApproval.resultJson) {
      try {
        const createResult = JSON.parse(relatedApproval.resultJson) as { data?: { draftId?: string } };
        const realDraftId = createResult.data?.draftId;
        if (realDraftId) {
          console.log(`[executeTool] Resolved draftId jobId=${args.draftId} → gmail_id=${realDraftId}`);
          args = { ...args, draftId: realDraftId };
        }
      } catch { /* ignore parse errors */ }
    }
  }
  const context: ToolContext = {
    requestId: crypto.randomUUID(),
    agentId,
  };

  // Inject Drive path rules.
  //
  // These were previously set only in server-manager.ts, which is a DIFFERENT
  // code path from this one — so on the live agent path drivePermission() fell
  // through to its 'write' default and per-folder rules were never enforced.
  // The gmail attachment resolver relies on these being present to stop a Drive
  // read being laundered through a Gmail tool.
  if (serviceType === 'drive' || serviceType === 'gmail') {
    const driveConfig = await getDrivePathConfig(agentId);
    context.driveDefaultLevel = driveConfig.defaultLevel;
    context.drivePathRules = driveConfig.rules;
  }

  // Inject gateway token for services that call back into the Reins API.
  // memory reads/writes memory entries; gmail resolves source="upload"
  // attachments via /api/agent-uploads; skills reads /api/agent-skills;
  // helm-admin reads and writes /api/agent-admin.
  //
  // Omitting a service here does not fail loudly: its handlers send no
  // x-reins-agent-secret and every call comes back 401, which reads like a
  // broken credential rather than a missing line in this list.
  if (
    serviceType === 'memory' ||
    serviceType === 'gmail' ||
    serviceType === 'skills' ||
    serviceType === 'skill-authoring' ||
    serviceType === 'helm-admin'
  ) {
    const depRow = await client.execute({
      sql: `SELECT gateway_token FROM deployed_agents WHERE agent_id = ? AND status NOT IN ('destroyed', 'error') ORDER BY created_at DESC LIMIT 1`,
      args: [agentId],
    });
    if (depRow.rows.length > 0) {
      context.gatewayToken = depRow.rows[0].gateway_token as string;
    }
  }

  const isListAccountsTool = toolName.endsWith('_list_accounts');

  if (hasInstances) {
    // Instance-based credential resolution
    if (isListAccountsTool) {
      const accounts: Array<{ email: string; name?: string; isDefault: boolean }> = [];
      for (const inst of serviceInstances) {
        if (inst.credentialId) {
          const [cred] = await db.select().from(credentials).where(eq(credentials.id, inst.credentialId));
          if (cred?.accountEmail) {
            accounts.push({
              email: cred.accountEmail,
              name: cred.accountName ?? undefined,
              isDefault: inst.isDefault,
            });
          }
        }
      }
      context.linkedAccounts = accounts;
    } else {
      // Resolve instance credential based on args.account or default
      const requestedAccount = args.account as string | undefined;
      let targetInstance = serviceInstances.find((i) => i.isDefault) ?? serviceInstances[0];

      if (requestedAccount) {
        let found = false;
        for (const inst of serviceInstances) {
          if (inst.credentialId) {
            const [cred] = await db.select().from(credentials).where(eq(credentials.id, inst.credentialId));
            if (cred?.accountEmail === requestedAccount) {
              targetInstance = inst;
              found = true;
              break;
            }
          }
        }
        if (!found) {
          return {
            success: false,
            errorCode: MCP_ERROR_CODES.MISSING_CREDENTIALS,
            errorMessage: `No credential found for account: ${requestedAccount}. Use ${serviceType}_list_accounts to see available accounts.`,
            errorData: { service: serviceType, requestedAccount },
          };
        }
      }

      // Strip `account` from args before passing to handler
      const { account: _account, ...cleanArgs } = args;
      args = cleanArgs;

      // Auto-heal: if instance has no credential, try to find a matching one now.
      if (!targetInstance.credentialId) {
        try {
          const { serviceDefinitions } = await import('@reins/servers');
          const def = serviceDefinitions.find((d) => d.type === serviceType);
          const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId));
          if (def && agentRow?.userId) {
            const serviceIds = def.auth.credentialServiceIds ?? [serviceType];
            const [matchingCred] = await db
              .select()
              .from(credentials)
              .where(and(inArray(credentials.serviceId, serviceIds), eq(credentials.userId, agentRow.userId)));
            if (matchingCred) {
              await db
                .update(agentServiceInstances)
                .set({ credentialId: matchingCred.id, updatedAt: new Date().toISOString() })
                .where(eq(agentServiceInstances.id, targetInstance.id));
              targetInstance = { ...targetInstance, credentialId: matchingCred.id };
            }
          }
        } catch (healErr) {
          console.warn(`[agent-endpoint] auto-heal failed for ${serviceType}:`, healErr);
        }
      }

      if (targetInstance.credentialId) {
        const credential = await credentialVault.retrieve(targetInstance.credentialId);
        if (credential) {
          context.credential = credential;
          const accessToken = await credentialVault.getValidAccessToken(targetInstance.credentialId);
          if (accessToken) {
            context.accessToken = accessToken;
            const hasScope = await credentialCoversService(targetInstance.credentialId, serviceType);
            if (!hasScope) {
              await createMCPReauthApproval(agentId, serviceType, targetInstance.credentialId).catch(() => {});
              return {
                success: false,
                errorCode: MCP_ERROR_CODES.MISSING_CREDENTIALS,
                errorMessage: `Credential for ${serviceType} has insufficient scope — please re-authenticate`,
                errorData: { service: serviceType, reason: 'insufficient_scope' },
              };
            }
          } else {
            await createMCPReauthApproval(agentId, serviceType, targetInstance.credentialId).catch(() => {});
            return {
              success: false,
              errorCode: MCP_ERROR_CODES.MISSING_CREDENTIALS,
              errorMessage: `Credentials expired and could not be refreshed for service: ${serviceType}`,
              errorData: { service: serviceType },
            };
          }
        }
      }
    }
  } else {
    // Legacy credential resolution path
    const linkedCreds = await db
      .select()
      .from(agentServiceCredentials)
      .where(and(eq(agentServiceCredentials.agentId, agentId), eq(agentServiceCredentials.serviceType, serviceType)));

    if (isListAccountsTool && linkedCreds.length > 0) {
      // Populate linkedAccounts from junction table + credentials metadata
      const accounts: Array<{ email: string; name?: string; isDefault: boolean }> = [];
      for (const lc of linkedCreds) {
        const [cred] = await db.select().from(credentials).where(eq(credentials.id, lc.credentialId));
        if (cred?.accountEmail) {
          accounts.push({
            email: cred.accountEmail,
            name: cred.accountName ?? undefined,
            isDefault: lc.isDefault,
          });
        }
      }
      context.linkedAccounts = accounts;
    } else if (linkedCreds.length > 0) {
      // Resolve credential based on args.account or default
      const requestedAccount = args.account as string | undefined;
      let targetCredentialId: string | undefined;

      if (requestedAccount) {
        // Find credential matching the requested account email
        for (const lc of linkedCreds) {
          const [cred] = await db.select().from(credentials).where(eq(credentials.id, lc.credentialId));
          if (cred?.accountEmail === requestedAccount) {
            targetCredentialId = lc.credentialId;
            break;
          }
        }
        if (!targetCredentialId) {
          return {
            success: false,
            errorCode: MCP_ERROR_CODES.MISSING_CREDENTIALS,
            errorMessage: `No credential found for account: ${requestedAccount}. Use gmail_list_accounts to see available accounts.`,
            errorData: { service: serviceType, requestedAccount },
          };
        }
      } else {
        // Use default credential, fall back to first
        const defaultCred = linkedCreds.find((lc) => lc.isDefault);
        targetCredentialId = defaultCred?.credentialId ?? linkedCreds[0].credentialId;
      }

      // Strip `account` from args before passing to handler
      const { account: _account, ...cleanArgs } = args;
      args = cleanArgs;

      const credential = await credentialVault.retrieve(targetCredentialId);
      if (credential) {
        context.credential = credential;
        const accessToken = await credentialVault.getValidAccessToken(targetCredentialId);
        if (accessToken) {
          context.accessToken = accessToken;
          const hasScope = await credentialCoversService(targetCredentialId, serviceType);
          if (!hasScope) {
            await createMCPReauthApproval(agentId, serviceType, targetCredentialId).catch(() => {});
            return {
              success: false,
              errorCode: MCP_ERROR_CODES.MISSING_CREDENTIALS,
              errorMessage: `Credential for ${serviceType} has insufficient scope — please re-authenticate`,
              errorData: { service: serviceType, reason: 'insufficient_scope' },
            };
          }
        } else {
          await createMCPReauthApproval(agentId, serviceType, targetCredentialId).catch(() => {});
          return {
            success: false,
            errorCode: MCP_ERROR_CODES.MISSING_CREDENTIALS,
            errorMessage: `Credentials expired and could not be refreshed for service: ${serviceType}`,
            errorData: { service: serviceType },
          };
        }
      }
    } else {
      // Fallback to legacy single credential from agent_service_access
      const [accessRecord] = await db
        .select()
        .from(agentServiceAccess)
        .where(and(eq(agentServiceAccess.agentId, agentId), eq(agentServiceAccess.serviceType, serviceType)));

      if (accessRecord?.credentialId) {
        const credential = await credentialVault.retrieve(accessRecord.credentialId);
        if (credential) {
          context.credential = credential;
          const accessToken = await credentialVault.getValidAccessToken(accessRecord.credentialId);
          if (accessToken) {
            context.accessToken = accessToken;
            const hasScope = await credentialCoversService(accessRecord.credentialId, serviceType);
            if (!hasScope) {
              await createMCPReauthApproval(agentId, serviceType, accessRecord.credentialId).catch(() => {});
              return {
                success: false,
                errorCode: MCP_ERROR_CODES.MISSING_CREDENTIALS,
                errorMessage: `Credential for ${serviceType} has insufficient scope — please re-authenticate`,
                errorData: { service: serviceType, reason: 'insufficient_scope' },
              };
            }
          } else {
            await createMCPReauthApproval(agentId, serviceType, accessRecord.credentialId).catch(() => {});
            return {
              success: false,
              errorCode: MCP_ERROR_CODES.MISSING_CREDENTIALS,
              errorMessage: `Credentials expired and could not be refreshed for service: ${serviceType}`,
              errorData: { service: serviceType },
            };
          }
        }
      } else {
        // Check if this service requires credentials (from registry)
        const serviceDef = _registryLoaded ? (await import('@reins/servers')).serviceRegistry.get(serviceType) : null;
        const requiresAuth = serviceDef?.auth.required ?? false;
        if (requiresAuth) {
          return {
            success: false,
            errorCode: MCP_ERROR_CODES.MISSING_CREDENTIALS,
            errorMessage: `No credentials linked for service: ${serviceType}`,
            errorData: { service: serviceType },
          };
        }
      }
    }
  }

  // Get the server and call the tool
  const server = serverManager.getServer(serviceType);
  if (!server) {
    return {
      success: false,
      errorCode: MCP_ERROR_CODES.SERVICE_NOT_ENABLED,
      errorMessage: `Server not available: ${serviceType}`,
      errorData: { service: serviceType },
    };
  }

  const toolResult = await server.callTool(toolName, args, context);
  if (toolResult.success) {
    return { success: true, data: toolResult.data };
  }
  // Tool ran but returned error (use isToolError flag, not errorCode)
  return {
    success: false,
    isToolError: true,
    errorMessage: typeof toolResult.error === 'string' ? toolResult.error : 'Unknown error',
  };
}

// ============================================================================
// tools/call Handler
// ============================================================================

/**
 * Handle tools/call request
 * Executes a tool with permission checking and approval workflows
 */
async function handleCallTool(
  agentId: string,
  rawToolName: string,
  args: Record<string, unknown>,
  requestId: string | number
): Promise<MCPResponse> {
  const startTime = Date.now();

  // Accept pre-rename tool names. tools/list advertises only the canonical
  // names, but agents deployed before the rename — and skills that name the old
  // tools in prose — keep working.
  const toolName = canonicalToolName(rawToolName);

  // Built-in tool: whoami — the calling agent's own id and name. Read-only and
  // already authenticated by the time we are here, so no policy check applies.
  if (toolName === BUILTIN_TOOLS.whoami) {
    const [self] = await db.select().from(agents).where(eq(agents.id, agentId));
    return {
      jsonrpc: '2.0', id: requestId,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ agentId, name: self?.name ?? null }) }],
      },
    };
  }

  // Built-in tool: get_result — poll for deferred approval job status
  if (toolName === BUILTIN_TOOLS.getResult) {
    let { jobId } = args as { jobId?: string };

    // Fallback: if no jobId supplied (some LLMs call the tool without arguments),
    // look up the most recent deferred approval for this agent.
    if (!jobId || typeof jobId !== 'string') {
      const latest = await approvalQueue.getLatestDeferred(agentId);
      if (latest) {
        jobId = latest.id;
      } else {
        return {
          jsonrpc: '2.0', id: requestId,
          result: {
            content: [{ type: 'text', text: 'No pending deferred job found for this agent.' }],
            isError: true,
          },
        };
      }
    }

    const approval = await approvalQueue.get(jobId);

    // Security: only return results for jobs belonging to this agent
    if (!approval || approval.agentId !== agentId) {
      await auditLogger.logToolCall(agentId, BUILTIN_TOOLS.getResult, args, 'blocked', Date.now() - startTime, {
        reason: 'Job not found or agent mismatch',
        jobId,
      });
      return {
        jsonrpc: '2.0', id: requestId,
        error: { code: MCP_ERROR_CODES.INVALID_PARAMS, message: `Job not found: ${jobId}`, data: {} },
      };
    }

    // Long-poll: block up to 30s waiting for resolution so the agent gets a definitive answer
    // in a single call instead of having to loop (which causes intermediate messages to users).
    let currentApproval = approval;
    if (currentApproval.status === 'pending') {
      const deadline = Date.now() + 30_000;
      while (currentApproval.status === 'pending' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        const refreshed = await approvalQueue.get(jobId as string);
        if (refreshed && refreshed.agentId === agentId) {
          currentApproval = refreshed;
        }
      }
    }

    let jobResult: DeferredJobResult;

    if (currentApproval.status === 'pending') {
      jobResult = { status: 'pending', jobId, message: pendingApprovalUserMessage() };
    } else if (currentApproval.status === 'rejected') {
      jobResult = { status: 'rejected', jobId, reason: currentApproval.resolutionComment };
    } else if (currentApproval.status === 'changes_requested') {
      const revisionsRemaining = Math.max(0, MAX_REVISIONS - currentApproval.revision);
      jobResult = {
        status: 'changes_requested',
        jobId,
        feedback: currentApproval.resolutionComment,
        instruction:
          `The human did NOT approve this as written and wants it redone. Revise the arguments ` +
          `according to "feedback" and call ${currentApproval.tool} again with the corrected ` +
          `arguments. Do not ask the user for permission first, and do not repeat the identical call.` +
          (revisionsRemaining <= 1
            ? ` This is your last revision — if it is sent back again you must stop and ask the user directly.`
            : ''),
        revisionsRemaining,
      };
    } else if (currentApproval.status === 'expired') {
      jobResult = { status: 'expired', jobId };
    } else {
      // approved — return result if execution completed, pending if executor hasn't run yet
      if (currentApproval.resultJson) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(currentApproval.resultJson);
        } catch {
          parsed = { raw: currentApproval.resultJson };
        }
        jobResult = { status: 'completed', jobId, result: parsed };
      } else {
        // Approved, but the executor has not finished. This reports the same
        // `pending` status as the awaiting-approval branch above and must not
        // reuse its message: the user has already approved, so sending them
        // back to /approvals would ask them to do a thing they just did.
        jobResult = { status: 'pending', jobId, message: approvedAwaitingResultMessage() };
      }
    }

    return {
      jsonrpc: '2.0', id: requestId,
      result: {
        content: [{ type: 'text', text: JSON.stringify(jobResult) }],
      },
    };
  }

  // Built-in tool: mark_onboarded — signal first-run setup complete
  if (toolName === BUILTIN_TOOLS.markOnboarded) {
    const depRow = await client.execute({
      sql: `SELECT id, fly_app_name, fly_machine_id FROM deployed_agents WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1`,
      args: [agentId],
    });
    const dep = depRow.rows[0];
    if (dep) {
      const now = new Date().toISOString();
      await client.execute({
        sql: `UPDATE deployed_agents SET has_onboarded = 1, initial_prompt = NULL, updated_at = ? WHERE id = ?`,
        args: [now, dep.id as string],
      });
      // Remove INITIAL_PROMPT env var from the Fly machine so it doesn't reappear on restart
      if (dep.fly_app_name && dep.fly_machine_id) {
        try {
          await updateMachineEnv(
            dep.fly_app_name as string,
            dep.fly_machine_id as string,
            { INITIAL_PROMPT: undefined }
          );
        } catch (err) {
          console.warn('[mark_onboarded] updateMachineEnv failed (non-fatal):', err instanceof Error ? err.message : err);
        }
      }
      // Fire-and-forget: notify the user via the shared approvals bot that their agent
      // finished first-run setup and is now ready to chat.
      if (config.sharedBotToken) {
        client.execute({
          sql: `SELECT u.telegram_chat_id FROM users u JOIN agents a ON a.user_id = u.id WHERE a.id = ? LIMIT 1`,
          args: [agentId],
        }).then((r) => {
          const chatId = r.rows[0]?.telegram_chat_id as string | null;
          if (!chatId) return;
          fetch(`https://api.telegram.org/bot${config.sharedBotToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: '✅ Your agent is ready! You can start chatting now.' }),
          }).catch(() => {});
        }).catch(() => {});
      }
    }
    return {
      jsonrpc: '2.0', id: requestId,
      result: {
        content: [{ type: 'text', text: 'First-run setup marked complete. These instructions will not appear again.' }],
      },
    };
  }

  // Subscription lapse gate (lenient: only blocks if subscription explicitly lapsed/canceled)
  {
    const agentOwner = await client.execute({
      sql: `SELECT a.user_id FROM agents a
            JOIN deployed_agents da ON da.agent_id = a.id
            WHERE da.id = ?
            LIMIT 1`,
      args: [agentId],
    });
    const ownerId = agentOwner.rows[0]?.user_id as string | undefined;
    if (ownerId) {
      const subGate = await checkUsageGate(ownerId);
      if (!subGate.allowed) {
        await auditLogger.logToolCall(agentId, toolName, args, 'blocked', Date.now() - startTime, { reason: 'subscription_lapsed' });
        return {
          jsonrpc: '2.0',
          id: requestId,
          result: {
            content: [{ type: 'text', text: 'Your subscription has lapsed. Your agent cannot make tool calls until you renew. Visit the dashboard to manage your billing.' }],
            isError: true,
          },
        };
      }
    }
  }

  // Check spend cap — block external tool calls when agent is soft-stopped
  {
    const cap = await checkSpendCap(client, agentId);
    if (!cap.allowed) {
      await auditLogger.logToolCall(agentId, toolName, args, 'blocked', Date.now() - startTime, {
        reason: 'spend_cap_exceeded',
      });
      return {
        jsonrpc: '2.0',
        id: requestId,
        result: {
          content: [{
            type: 'text',
            text: 'Your agent has reached its monthly spend cap and cannot execute tools. Please inform the user and ask them to raise the cap in the AgentHelm dashboard.',
          }],
          isError: true,
        },
      };
    }
  }

  // Determine service type from tool name
  const serviceType = getServiceTypeFromTool(toolName);
  if (!serviceType) {
    return {
      jsonrpc: '2.0',
      id: requestId,
      error: {
        code: MCP_ERROR_CODES.INVALID_PARAMS,
        message: `Unknown tool: ${toolName}`,
        data: { tool: toolName },
      },
    };
  }

  // Find instances for this agent+service
  const serviceInstances = await db
    .select()
    .from(agentServiceInstances)
    .where(and(
      eq(agentServiceInstances.agentId, agentId),
      eq(agentServiceInstances.serviceType, serviceType),
      eq(agentServiceInstances.enabled, true)
    ));

  // Check if service is enabled (either via instances or legacy).
  //
  // Same rule as isServiceEnabledForAgent() in services/permissions.ts, which is
  // what the gateway-token HTTP routes use. Kept inline here because the rows are
  // needed below for credential resolution and the helper would re-query them —
  // change one, change the other, or a tool blocked over MCP becomes reachable
  // over HTTP.
  const hasInstances = serviceInstances.length > 0;
  if (!hasInstances) {
    const { enabled } = await getEffectivePermissions(agentId, serviceType);
    if (!enabled) {
      return {
        jsonrpc: '2.0',
        id: requestId,
        error: {
          code: MCP_ERROR_CODES.SERVICE_NOT_ENABLED,
          message: `Service not enabled for this agent: ${serviceType}`,
          data: { service: serviceType },
        },
      };
    }
  }

  // Check tool permission (instance-based or legacy)
  let allowed: boolean;
  let requiresApproval: boolean;

  if (hasInstances) {
    // Resolve which instance to use based on `account` arg
    const requestedAccount = args.account as string | undefined;
    let targetInstance = serviceInstances[0]; // default

    if (requestedAccount) {
      // Find instance by credential email
      for (const inst of serviceInstances) {
        if (inst.credentialId) {
          const [cred] = await db.select().from(credentials).where(eq(credentials.id, inst.credentialId));
          if (cred?.accountEmail === requestedAccount) {
            targetInstance = inst;
            break;
          }
        }
      }
    } else {
      // Use default instance
      const defaultInst = serviceInstances.find((i) => i.isDefault);
      if (defaultInst) targetInstance = defaultInst;
    }

    const { tools: instanceToolPerms } = await getEffectiveInstancePermissions(targetInstance.id);
    const toolPerm = instanceToolPerms[toolName] ?? 'block';
    allowed = toolPerm !== 'block';
    requiresApproval = toolPerm === 'require_approval';
  } else {
    const result = await canAccessTool(agentId, serviceType, toolName);
    allowed = result.allowed;
    requiresApproval = result.requiresApproval;
  }

  if (!allowed) {
    await auditLogger.logToolCall(agentId, toolName, args, 'blocked', Date.now() - startTime, {
      reason: 'Tool blocked by policy',
      serviceType,
    });

    return {
      jsonrpc: '2.0',
      id: requestId,
      error: {
        code: MCP_ERROR_CODES.TOOL_BLOCKED,
        message: 'Tool blocked by policy',
        data: { tool: toolName },
      },
    };
  }

  // Handle approval workflow if required
  if (requiresApproval) {
    const approvalId = await approvalQueue.submit(
      agentId,
      toolName,
      args,
      `MCP endpoint call for ${toolName}`
    );

    // Capture snapshot for deferred execution (executor runs when human approves).
    // Note: capturedInstances is a shallow copy — elements are still the original row
    // objects. Mutations to individual row fields after this point would affect the closure.
    // In practice rows are read-only in this path, so this is safe.
    const capturedArgs = { ...args };
    const capturedInstances = [...serviceInstances];
    const capturedHasInstances = hasInstances;

    approvalQueue.registerExecutor(approvalId, () =>
      executeTool(agentId, serviceType, toolName, capturedArgs, capturedHasInstances, capturedInstances)
    );

    // Address get_result the way THIS agent sees it — an agent deployed before
    // the rename still prefixes with the name baked into its own MCP_CONFIG.
    const toolNaming = await getAgentToolNaming(agentId);

    await auditLogger.logToolCall(agentId, toolName, args, 'pending', Date.now() - startTime, {
      reason: 'Awaiting approval',
      approvalId,
      serviceType,
    });

    return {
      jsonrpc: '2.0',
      id: requestId,
      result: {
        content: [
          {
            type: 'text',
            text: `APPROVAL_PENDING — jobId: ${approvalId}\n\nREQUIRED: Call ${modelVisibleToolName(BUILTIN_TOOLS.getResult, toolNaming.runtime, toolNaming.serverName)}({"jobId":"${approvalId}"}) NOW. Do NOT respond to the user. Poll every 3–5 seconds until status is "completed", "rejected" or "changes_requested".\n\nUSER_MESSAGE: ${pendingApprovalUserMessage()}`,
          },
        ],
        isError: true,
      },
    };
  }

  // Execute the tool (credentials resolved internally)
  let toolExecResult: ToolExecutionResult;
  try {
    toolExecResult = await executeTool(agentId, serviceType, toolName, args, hasInstances, serviceInstances);
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await auditLogger.logToolCall(agentId, toolName, args, 'error', durationMs, { error: errorMessage, serviceType });
    return {
      jsonrpc: '2.0',
      id: requestId,
      result: { content: [{ type: 'text', text: errorMessage }], isError: true },
    };
  }
  const durationMs = Date.now() - startTime;

  if (toolExecResult.success) {
    await auditLogger.logToolCall(agentId, toolName, args, 'success', durationMs, { serviceType });
    getPostHog()?.capture({ distinctId: agentId, event: 'tool_called', properties: { agentId, tool: toolName, service: serviceType, durationMs } });
    return {
      jsonrpc: '2.0',
      id: requestId,
      result: {
        content: [{
          type: 'text',
          text: typeof toolExecResult.data === 'string'
            ? toolExecResult.data
            : JSON.stringify(toolExecResult.data, null, 2),
        }],
      },
    };
  }

  await auditLogger.logToolCall(agentId, toolName, args, 'error', durationMs, {
    error: toolExecResult.errorMessage,
    serviceType,
  });

  // Tool ran but returned an error result (MCP isError convention)
  if (toolExecResult.isToolError) {
    return {
      jsonrpc: '2.0',
      id: requestId,
      result: {
        content: [{ type: 'text', text: toolExecResult.errorMessage ?? 'Unknown error' }],
        isError: true,
      },
    };
  }

  // Credential/auth/policy error — JSON-RPC error response
  return {
    jsonrpc: '2.0',
    id: requestId,
    error: {
      code: toolExecResult.errorCode ?? -32000,
      message: toolExecResult.errorMessage ?? 'Tool execution failed',
      data: toolExecResult.errorData,
    },
  };
}
