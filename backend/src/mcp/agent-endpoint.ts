/**
 * MCP Agent Endpoint Handler
 *
 * Implements JSON-RPC 2.0 protocol for MCP tool discovery and execution.
 * Aggregates tools from all enabled services, filters based on agent permissions,
 * and routes tool calls with permission checking and approval workflows.
 */

import { db } from '../db/index.js';
import { agents, agentServiceAccess } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { serverManager, type NativeServerType, type ToolContext } from './server-manager.js';
import {
  getEffectivePermissions,
  canAccessTool,
  type ServiceType,
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
  method: 'tools/list' | 'tools/call';
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
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
// Service Type Mapping
// ============================================================================

const SERVICE_TYPES: ServiceType[] = ['gmail', 'drive', 'calendar', 'web-search', 'browser'];

/**
 * Determine service type from tool name prefix
 */
export function getServiceTypeFromTool(toolName: string): ServiceType | null {
  if (toolName.startsWith('gmail_')) return 'gmail';
  if (toolName.startsWith('drive_')) return 'drive';
  if (toolName.startsWith('calendar_')) return 'calendar';
  if (toolName.startsWith('web_search')) return 'web-search';
  if (toolName.startsWith('browser_')) return 'browser';
  return null;
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
 * Returns all visible tools for the agent across enabled services
 */
async function handleListTools(
  agentId: string,
  requestId: string | number
): Promise<MCPResponse> {
  const tools: MCPToolSchema[] = [];

  // Iterate over all service types
  for (const serviceType of SERVICE_TYPES) {
    const { enabled, tools: toolPermissions } = await getEffectivePermissions(agentId, serviceType);

    if (!enabled) {
      continue;
    }

    // Get server for this service type
    const server = serverManager.getServer(serviceType as NativeServerType);
    if (!server) {
      continue;
    }

    // Get tool definitions from the server
    const serverTools = server.getToolDefinitions();

    // Filter tools based on permissions - only include 'allow' and 'require_approval'
    for (const tool of serverTools) {
      const permission = toolPermissions[tool.name] as ToolPermission | undefined;

      // Default to 'block' if no permission set
      if (permission === 'allow' || permission === 'require_approval') {
        tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
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

  // Check if service is enabled for this agent
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

  // Check tool permission
  const { allowed, requiresApproval } = await canAccessTool(agentId, serviceType, toolName);

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

  // Get credential for service
  const [accessRecord] = await db
    .select()
    .from(agentServiceAccess)
    .where(and(eq(agentServiceAccess.agentId, agentId), eq(agentServiceAccess.serviceType, serviceType)));

  // Build tool context
  const context: ToolContext = {
    requestId: crypto.randomUUID(),
    agentId,
  };

  // Get credentials if linked
  if (accessRecord?.credentialId) {
    const credential = await credentialVault.retrieve(accessRecord.credentialId);
    if (credential) {
      context.credential = credential;
      // Extract access token for OAuth credentials
      const data = credential.data as { accessToken?: string };
      context.accessToken = data.accessToken;
    }
  } else {
    // Check if this service requires credentials (Google services do)
    const requiresAuth = ['gmail', 'drive', 'calendar'].includes(serviceType);
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

  // Get the server and call the tool
  const server = serverManager.getServer(serviceType as NativeServerType);
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
