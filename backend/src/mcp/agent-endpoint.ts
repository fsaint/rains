/**
 * MCP Agent Endpoint Handler
 *
 * Implements JSON-RPC 2.0 protocol for MCP tool discovery and execution.
 * Aggregates tools from all enabled services, filters based on agent permissions,
 * and routes tool calls with permission checking and approval workflows.
 */

import { db, client } from '../db/index.js';
import { agents, agentServiceAccess, agentServiceCredentials, agentServiceInstances, credentials } from '../db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import { serverManager, type ToolContext } from './server-manager.js';
import {
  getEffectivePermissions,
  getEffectiveInstancePermissions,
  canAccessTool,
  type ToolPermission,
} from '../services/permissions.js';
import { approvalQueue } from '../approvals/queue.js';
import { auditLogger } from '../audit/logger.js';
import { credentialVault } from '../credentials/vault.js';
import { sendReauthEmail } from '../services/email.js';
import { config } from '../config/index.js';
import { getPostHog } from '../analytics/posthog.js';
import type { DeferredJobResult } from '@reins/shared';

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
            name: 'reins',
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

  // Always inject the built-in reins_get_result polling tool
  tools.push({
    name: 'reins_get_result',
    description:
      'Check the status of a deferred tool call that required approval. ' +
      'Returns status: pending | completed | rejected | expired. ' +
      'When completed, includes the result of the original tool call.',
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

  return {
    jsonrpc: '2.0',
    id: requestId,
    result: {
      tools,
    },
  };
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
  toolName: string,
  args: Record<string, unknown>,
  requestId: string | number
): Promise<MCPResponse> {
  const startTime = Date.now();

  // Built-in tool: reins_get_result — poll for deferred approval job status
  if (toolName === 'reins_get_result') {
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
      await auditLogger.logToolCall(agentId, 'reins_get_result', args, 'blocked', Date.now() - startTime, {
        reason: 'Job not found or agent mismatch',
        jobId,
      });
      return {
        jsonrpc: '2.0', id: requestId,
        error: { code: MCP_ERROR_CODES.INVALID_PARAMS, message: `Job not found: ${jobId}`, data: {} },
      };
    }

    let jobResult: DeferredJobResult;

    if (approval.status === 'pending') {
      jobResult = { status: 'pending', jobId };
    } else if (approval.status === 'rejected') {
      jobResult = { status: 'rejected', jobId, reason: approval.resolutionComment };
    } else if (approval.status === 'expired') {
      jobResult = { status: 'expired', jobId };
    } else {
      // approved — return result if execution completed, pending if executor hasn't run yet
      if (approval.resultJson) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(approval.resultJson);
        } catch {
          parsed = { raw: approval.resultJson };
        }
        jobResult = { status: 'completed', jobId, result: parsed };
      } else {
        jobResult = { status: 'pending', jobId };
      }
    }

    return {
      jsonrpc: '2.0', id: requestId,
      result: {
        content: [{ type: 'text', text: JSON.stringify(jobResult) }],
      },
    };
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

  // Check if service is enabled (either via instances or legacy)
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

    await auditLogger.logToolCall(agentId, toolName, args, 'pending', Date.now() - startTime, {
      reason: 'Awaiting approval',
      approvalId,
      serviceType,
    });

    return {
      jsonrpc: '2.0',
      id: requestId,
      result: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'APPROVAL_PENDING',
            jobId: approvalId,
            instruction: 'Do NOT respond to the user. Call the reins_get_result tool immediately.',
            required_tool_call: {
              tool: 'reins_get_result',
              arguments: { jobId: approvalId },
            },
            on_pending: 'Call reins_get_result again with the same jobId after a few seconds.',
            on_completed: 'Report the result to the user.',
            on_rejected: 'Tell the user the request was denied.',
          }),
        }],
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
