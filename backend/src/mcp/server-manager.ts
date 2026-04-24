/**
 * Server Manager
 *
 * Manages native MCP servers (Gmail, Drive, Calendar, Web Search, Browser)
 * and integrates them with the existing proxy infrastructure.
 */

import { EventEmitter } from 'events';
import { policyEngine } from '../policy/engine.js';
import { approvalQueue } from '../approvals/queue.js';
import { auditLogger } from '../audit/logger.js';
import { credentialVault } from '../credentials/vault.js';
import { getDrivePathConfig } from '../services/permissions.js';
import type { ParsedPolicy, CredentialType, CredentialData } from '@reins/shared';

/**
 * Tool definition from native servers
 */
export interface NativeServerTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Context for tool execution
 */
export interface ToolContext {
  requestId: string;
  agentId: string;
  accessToken?: string;
  credential?: {
    serviceId: string;
    type: CredentialType;
    data: CredentialData;
  };
  linkedAccounts?: Array<{ email: string; name?: string; isDefault: boolean }>;
  /** Default Drive permission level (injected for drive tools) */
  driveDefaultLevel?: 'read' | 'write' | 'blocked';
  /** Per-folder Drive path rules (injected for drive tools) */
  drivePathRules?: Array<{ folderId: string; label?: string; permission: 'read' | 'write' | 'blocked' }>;
}

/**
 * Result from tool execution
 */
export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Native server interface that all servers must implement
 */
export interface NativeServer {
  readonly serverType: string;
  readonly name: string;
  getToolDefinitions(): NativeServerTool[];
  callTool(toolName: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  hasValidCredentials?(): Promise<boolean>;
}

/**
 * Server registration
 */
interface ServerRegistration {
  server: NativeServer;
  credentialId?: string;
  enabled: boolean;
}

/**
 * Events emitted by the server manager
 */
export interface ServerManagerEvents {
  'server_registered': [{ serverType: string; name: string }];
  'server_unregistered': [{ serverType: string }];
  'tool_call': [{ serverType: string; tool: string; result: string; agentId: string }];
  'error': [Error];
}

/**
 * Manages native MCP servers and routes tool calls
 */
export class ServerManager extends EventEmitter<ServerManagerEvents> {
  private servers: Map<string, ServerRegistration> = new Map();

  /**
   * Register a native server
   */
  registerServer(
    server: NativeServer,
    credentialId?: string
  ): void {
    this.servers.set(server.serverType, {
      server,
      credentialId,
      enabled: true,
    });

    this.emit('server_registered', {
      serverType: server.serverType,
      name: server.name,
    });
  }

  /**
   * Unregister a native server
   */
  unregisterServer(serverType: string): void {
    this.servers.delete(serverType);
    this.emit('server_unregistered', { serverType });
  }

  /**
   * Enable/disable a server
   */
  setServerEnabled(serverType: string, enabled: boolean): void {
    const registration = this.servers.get(serverType);
    if (registration) {
      registration.enabled = enabled;
    }
  }

  /**
   * Get a registered server
   */
  getServer(serverType: string): NativeServer | undefined {
    const registration = this.servers.get(serverType);
    if (registration?.enabled) {
      return registration.server;
    }
    return undefined;
  }

  /**
   * Get all registered server types
   */
  getServerTypes(): string[] {
    return Array.from(this.servers.keys()).filter(
      (type) => this.servers.get(type)?.enabled
    );
  }

  /**
   * Get tools from all enabled servers, filtered by policy
   */
  getFilteredTools(policy: ParsedPolicy): Array<{ serverType: string; tools: NativeServerTool[] }> {
    const result: Array<{ serverType: string; tools: NativeServerTool[] }> = [];

    for (const [serverType, registration] of this.servers) {
      if (!registration.enabled) continue;

      const allTools = registration.server.getToolDefinitions();
      const filteredToolNames = policyEngine.filterTools(
        allTools.map((t) => ({ name: t.name })),
        serverType,
        policy
      ).map((t) => t.name);

      const allowedTools = allTools.filter((t) => filteredToolNames.includes(t.name));

      if (allowedTools.length > 0) {
        result.push({
          serverType,
          tools: allowedTools,
        });
      }
    }

    return result;
  }

  /**
   * Get tools for a specific server type, filtered by policy
   */
  getServerTools(serverType: string, policy: ParsedPolicy): NativeServerTool[] {
    const registration = this.servers.get(serverType);
    if (!registration?.enabled) return [];

    const allTools = registration.server.getToolDefinitions();
    const filteredToolNames = policyEngine.filterTools(
      allTools.map((t) => ({ name: t.name })),
      serverType,
      policy
    ).map((t) => t.name);

    return allTools.filter((t) => filteredToolNames.includes(t.name));
  }

  /**
   * Get all tools for a specific server type (no policy filtering)
   */
  getAllServerTools(serverType: string): NativeServerTool[] {
    const registration = this.servers.get(serverType);
    if (!registration) return [];
    return registration.server.getToolDefinitions();
  }

  /**
   * Call a tool on a native server with policy enforcement
   */
  async callTool(
    agentId: string,
    serverType: string,
    toolName: string,
    args: Record<string, unknown>,
    policy: ParsedPolicy
  ): Promise<{ content: unknown; isError?: boolean }> {
    const startTime = Date.now();
    const registration = this.servers.get(serverType);

    if (!registration?.enabled) {
      throw new Error(`Server ${serverType} not available`);
    }

    // Evaluate policy
    const decision = policyEngine.evaluateTool(toolName, serverType, policy);

    if (decision.action === 'block') {
      await auditLogger.logToolCall(agentId, toolName, args, 'blocked', Date.now() - startTime, {
        reason: decision.reason,
        serverType,
      });

      this.emit('tool_call', { serverType, tool: toolName, result: 'blocked', agentId });

      return {
        content: [{ type: 'text', text: `Blocked: ${decision.reason}` }],
        isError: true,
      };
    }

    // Handle approval requirement
    if (decision.action === 'require_approval') {
      const approvalId = await approvalQueue.submit(agentId, toolName, args);

      // Wait for approval (with timeout)
      const approvalDecision = await approvalQueue.waitForDecision(approvalId, 5 * 60 * 1000);

      if (!approvalDecision || !approvalDecision.approved) {
        await auditLogger.logToolCall(agentId, toolName, args, 'blocked', Date.now() - startTime, {
          reason: 'Approval denied or timed out',
          serverType,
        });

        this.emit('tool_call', { serverType, tool: toolName, result: 'blocked', agentId });

        return {
          content: [{ type: 'text', text: 'Request was not approved' }],
          isError: true,
        };
      }

      await auditLogger.logApproval(agentId, toolName, 'success', approvalDecision.approver);
    }

    // Apply constraints
    const constrainedArgs = policyEngine.applyConstraints(toolName, serverType, args, policy);

    // Build context with credentials
    const context: ToolContext = {
      requestId: crypto.randomUUID(),
      agentId,
    };

    // Get credentials if available
    if (registration.credentialId) {
      const credential = await credentialVault.retrieve(registration.credentialId);
      if (credential) {
        context.credential = credential;
        // Extract access token for OAuth credentials
        const data = credential.data as { accessToken?: string };
        context.accessToken = data.accessToken;
      }
    }

    // Inject Drive path rules for drive tools
    if (serverType === 'drive') {
      const driveConfig = await getDrivePathConfig(agentId);
      context.driveDefaultLevel = driveConfig.defaultLevel;
      context.drivePathRules = driveConfig.rules;
    }

    // Call the tool
    try {
      const result = await registration.server.callTool(
        toolName,
        constrainedArgs,
        context
      );

      const durationMs = Date.now() - startTime;

      if (result.success) {
        await auditLogger.logToolCall(agentId, toolName, args, 'success', durationMs, {
          serverType,
        });
        this.emit('tool_call', { serverType, tool: toolName, result: 'success', agentId });

        return {
          content: [
            {
              type: 'text',
              text: typeof result.data === 'string'
                ? result.data
                : JSON.stringify(result.data, null, 2),
            },
          ],
        };
      } else {
        await auditLogger.logToolCall(agentId, toolName, args, 'error', durationMs, {
          error: result.error,
          serverType,
        });
        this.emit('tool_call', { serverType, tool: toolName, result: 'error', agentId });

        return {
          content: [{ type: 'text', text: result.error ?? 'Unknown error' }],
          isError: true,
        };
      }
    } catch (error) {
      const durationMs = Date.now() - startTime;
      await auditLogger.logToolCall(agentId, toolName, args, 'error', durationMs, {
        error: (error as Error).message,
        serverType,
      });
      this.emit('tool_call', { serverType, tool: toolName, result: 'error', agentId });
      throw error;
    }
  }

  /**
   * Check server health (credentials valid, etc.)
   */
  async checkServerHealth(serverType: string): Promise<{
    available: boolean;
    hasCredentials: boolean;
    credentialsValid: boolean;
  }> {
    const registration = this.servers.get(serverType);

    if (!registration) {
      return {
        available: false,
        hasCredentials: false,
        credentialsValid: false,
      };
    }

    const hasCredentials = !!registration.credentialId;
    let credentialsValid = false;

    if (hasCredentials && registration.server.hasValidCredentials) {
      credentialsValid = await registration.server.hasValidCredentials();
    }

    return {
      available: registration.enabled,
      hasCredentials,
      credentialsValid,
    };
  }

  /**
   * Get status of all servers
   */
  async getStatus(): Promise<
    Array<{
      serverType: string;
      name: string;
      enabled: boolean;
      toolCount: number;
    }>
  > {
    const status: Array<{
      serverType: string;
      name: string;
      enabled: boolean;
      toolCount: number;
    }> = [];

    for (const [serverType, registration] of this.servers) {
      status.push({
        serverType,
        name: registration.server.name,
        enabled: registration.enabled,
        toolCount: registration.server.getToolDefinitions().length,
      });
    }

    return status;
  }
}

// Singleton instance
export const serverManager = new ServerManager();
