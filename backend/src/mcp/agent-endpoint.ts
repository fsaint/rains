/**
 * MCP Agent Endpoint Handler
 *
 * Implements JSON-RPC 2.0 protocol for MCP tool discovery and execution.
 * Aggregates tools from all enabled services, filters based on agent permissions,
 * and routes tool calls with permission checking and approval workflows.
 */

import { db } from '../db/index.js';
import { agents, agentServiceAccess, agentServiceCredentials, agentServiceInstances, credentials } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
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

  return {
    jsonrpc: '2.0',
    id: requestId,
    result: {
      tools,
    },
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

    // Wait for approval (5 minute timeout)
    const decision = await approvalQueue.waitForDecision(approvalId, 5 * 60 * 1000);

    if (!decision || !decision.approved) {
      await auditLogger.logToolCall(agentId, toolName, args, 'blocked', Date.now() - startTime, {
        reason: decision ? 'Approval denied' : 'Approval timeout',
        approvalId,
        serviceType,
      });

      return {
        jsonrpc: '2.0',
        id: requestId,
        error: {
          code: MCP_ERROR_CODES.APPROVAL_DENIED,
          message: decision ? 'Approval denied' : 'Approval timed out',
          data: { tool: toolName, approvalId },
        },
      };
    }

    await auditLogger.logApproval(agentId, toolName, 'success', decision.approver);
  }

  // Multi-account credential resolution
  // First try instances, then fall back to legacy junction table
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
            jsonrpc: '2.0',
            id: requestId,
            error: {
              code: MCP_ERROR_CODES.MISSING_CREDENTIALS,
              message: `No credential found for account: ${requestedAccount}. Use ${serviceType}_list_accounts to see available accounts.`,
              data: { service: serviceType, requestedAccount },
            },
          };
        }
      }

      // Strip `account` from args before passing to handler
      const { account: _account, ...cleanArgs } = args;
      args = cleanArgs;

      if (targetInstance.credentialId) {
        const credential = await credentialVault.retrieve(targetInstance.credentialId);
        if (credential) {
          context.credential = credential;
          const accessToken = await credentialVault.getValidAccessToken(targetInstance.credentialId);
          if (accessToken) {
            context.accessToken = accessToken;
          } else {
            return {
              jsonrpc: '2.0',
              id: requestId,
              error: {
                code: MCP_ERROR_CODES.MISSING_CREDENTIALS,
                message: `Credentials expired and could not be refreshed for service: ${serviceType}`,
                data: { service: serviceType },
              },
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
          jsonrpc: '2.0',
          id: requestId,
          error: {
            code: MCP_ERROR_CODES.MISSING_CREDENTIALS,
            message: `No credential found for account: ${requestedAccount}. Use gmail_list_accounts to see available accounts.`,
            data: { service: serviceType, requestedAccount },
          },
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
      } else {
        return {
          jsonrpc: '2.0',
          id: requestId,
          error: {
            code: MCP_ERROR_CODES.MISSING_CREDENTIALS,
            message: `Credentials expired and could not be refreshed for service: ${serviceType}`,
            data: { service: serviceType },
          },
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
        } else {
          return {
            jsonrpc: '2.0',
            id: requestId,
            error: {
              code: MCP_ERROR_CODES.MISSING_CREDENTIALS,
              message: `Credentials expired and could not be refreshed for service: ${serviceType}`,
              data: { service: serviceType },
            },
          };
        }
      }
    } else {
      // Check if this service requires credentials (from registry)
      const serviceDef = _registryLoaded ? (await import('@reins/servers')).serviceRegistry.get(serviceType) : null;
      const requiresAuth = serviceDef?.auth.required ?? false;
      if (requiresAuth) {
        return {
          jsonrpc: '2.0',
          id: requestId,
          error: {
            code: MCP_ERROR_CODES.MISSING_CREDENTIALS,
            message: `No credentials linked for service: ${serviceType}`,
            data: { service: serviceType },
          },
        };
      }
    }
  }
  } // end hasInstances else

  // Get the server and call the tool
  const server = serverManager.getServer(serviceType );
  if (!server) {
    return {
      jsonrpc: '2.0',
      id: requestId,
      error: {
        code: MCP_ERROR_CODES.SERVICE_NOT_ENABLED,
        message: `Server not available: ${serviceType}`,
        data: { service: serviceType },
      },
    };
  }

  try {
    const result = await server.callTool(toolName, args, context);
    const durationMs = Date.now() - startTime;

    if (result.success) {
      await auditLogger.logToolCall(agentId, toolName, args, 'success', durationMs, {
        serviceType,
      });

      return {
        jsonrpc: '2.0',
        id: requestId,
        result: {
          content: [
            {
              type: 'text',
              text: typeof result.data === 'string'
                ? result.data
                : JSON.stringify(result.data, null, 2),
            },
          ],
        },
      };
    } else {
      await auditLogger.logToolCall(agentId, toolName, args, 'error', durationMs, {
        error: result.error,
        serviceType,
      });

      return {
        jsonrpc: '2.0',
        id: requestId,
        result: {
          content: [{ type: 'text', text: result.error ?? 'Unknown error' }],
          isError: true,
        },
      };
    }
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    await auditLogger.logToolCall(agentId, toolName, args, 'error', durationMs, {
      error: errorMessage,
      serviceType,
    });

    return {
      jsonrpc: '2.0',
      id: requestId,
      result: {
        content: [{ type: 'text', text: errorMessage }],
        isError: true,
      },
    };
  }
}
