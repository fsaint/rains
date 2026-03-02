import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { EventEmitter } from 'events';
import { policyEngine } from '../policy/engine.js';
import { approvalQueue } from '../approvals/queue.js';
import { auditLogger } from '../audit/logger.js';
import type { ParsedPolicy, MCPServerConfig, StdioConfig } from '@reins/shared';

interface Tool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface ProxyConnection {
  id: string;
  client: Client;
  transport: StdioClientTransport;
  tools: Tool[];
  serverConfig: MCPServerConfig;
  agentId: string;
  policy: ParsedPolicy;
}

export interface ProxyEvents {
  'connection': [{ agentId: string; serverId: string }];
  'disconnection': [{ agentId: string; serverId: string }];
  'tool_call': [{ agentId: string; tool: string; result: string }];
  'error': [Error];
}

export class MCPProxy extends EventEmitter<ProxyEvents> {
  private connections: Map<string, ProxyConnection> = new Map();

  /**
   * Connect to a downstream MCP server
   */
  async connect(
    agentId: string,
    serverConfig: MCPServerConfig,
    policy: ParsedPolicy
  ): Promise<string> {
    const connectionId = `${agentId}:${serverConfig.id}`;

    if (this.connections.has(connectionId)) {
      throw new Error(`Connection ${connectionId} already exists`);
    }

    if (serverConfig.transport !== 'stdio') {
      throw new Error(`Transport ${serverConfig.transport} not yet supported`);
    }

    const config = serverConfig.config as StdioConfig;

    // Create transport and client
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
    });

    const client = new Client(
      { name: 'reins-proxy', version: '0.1.0' },
      { capabilities: {} }
    );

    await client.connect(transport);

    // Get available tools
    const toolsResult = await client.listTools();
    const allTools = toolsResult.tools as Tool[];

    // Filter tools based on policy
    const service = serverConfig.name;
    const filteredTools = policyEngine.filterTools(allTools, service, policy);

    const connection: ProxyConnection = {
      id: connectionId,
      client,
      transport,
      tools: filteredTools,
      serverConfig,
      agentId,
      policy,
    };

    this.connections.set(connectionId, connection);

    await auditLogger.logConnection(agentId, 'connected', serverConfig.transport);
    this.emit('connection', { agentId, serverId: serverConfig.id });

    return connectionId;
  }

  /**
   * Disconnect from a downstream MCP server
   */
  async disconnect(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    await connection.client.close();
    this.connections.delete(connectionId);

    await auditLogger.logConnection(
      connection.agentId,
      'disconnected',
      connection.serverConfig.transport
    );
    this.emit('disconnection', {
      agentId: connection.agentId,
      serverId: connection.serverConfig.id,
    });
  }

  /**
   * Get filtered tools for a connection
   */
  getTools(connectionId: string): Tool[] {
    const connection = this.connections.get(connectionId);
    return connection?.tools ?? [];
  }

  /**
   * Call a tool on a downstream MCP server
   */
  async callTool(
    connectionId: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<{ content: unknown; isError?: boolean }> {
    const startTime = Date.now();
    const connection = this.connections.get(connectionId);

    if (!connection) {
      throw new Error(`Connection ${connectionId} not found`);
    }

    const service = connection.serverConfig.name;
    const { agentId, policy } = connection;

    // Evaluate policy
    const decision = policyEngine.evaluateTool(tool, service, policy);

    if (decision.action === 'block') {
      await auditLogger.logToolCall(agentId, tool, args, 'blocked', Date.now() - startTime, {
        reason: decision.reason,
      });

      this.emit('tool_call', { agentId, tool, result: 'blocked' });

      return {
        content: [{ type: 'text', text: `Blocked: ${decision.reason}` }],
        isError: true,
      };
    }

    // Handle approval requirement
    if (decision.action === 'require_approval') {
      const approvalId = await approvalQueue.submit(agentId, tool, args);

      // Wait for approval (with timeout)
      const approvalDecision = await approvalQueue.waitForDecision(approvalId, 5 * 60 * 1000);

      if (!approvalDecision || !approvalDecision.approved) {
        await auditLogger.logToolCall(agentId, tool, args, 'blocked', Date.now() - startTime, {
          reason: 'Approval denied or timed out',
        });

        this.emit('tool_call', { agentId, tool, result: 'blocked' });

        return {
          content: [{ type: 'text', text: 'Request was not approved' }],
          isError: true,
        };
      }

      await auditLogger.logApproval(agentId, tool, 'success', approvalDecision.approver);
    }

    // Apply constraints
    const constrainedArgs = policyEngine.applyConstraints(tool, service, args, policy);

    // Call the tool
    try {
      const result = await connection.client.callTool({
        name: tool,
        arguments: constrainedArgs,
      });

      const durationMs = Date.now() - startTime;
      await auditLogger.logToolCall(agentId, tool, args, 'success', durationMs);
      this.emit('tool_call', { agentId, tool, result: 'success' });

      return {
        content: result.content,
        isError: result.isError as boolean | undefined,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      await auditLogger.logToolCall(agentId, tool, args, 'error', durationMs, {
        error: (error as Error).message,
      });
      this.emit('tool_call', { agentId, tool, result: 'error' });
      throw error;
    }
  }

  /**
   * List active connections
   */
  listConnections(): Array<{
    id: string;
    agentId: string;
    serverId: string;
    toolCount: number;
  }> {
    return Array.from(this.connections.values()).map((conn) => ({
      id: conn.id,
      agentId: conn.agentId,
      serverId: conn.serverConfig.id,
      toolCount: conn.tools.length,
    }));
  }

  /**
   * Disconnect all connections for an agent
   */
  async disconnectAgent(agentId: string): Promise<void> {
    const agentConnections = Array.from(this.connections.entries())
      .filter(([_, conn]) => conn.agentId === agentId);

    await Promise.all(
      agentConnections.map(([id]) => this.disconnect(id))
    );
  }

  /**
   * Disconnect all connections
   */
  async disconnectAll(): Promise<void> {
    await Promise.all(
      Array.from(this.connections.keys()).map((id) => this.disconnect(id))
    );
  }
}

export const mcpProxy = new MCPProxy();
