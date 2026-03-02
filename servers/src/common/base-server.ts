/**
 * Base MCP Server class providing common functionality
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type TextContent,
} from '@modelcontextprotocol/sdk/types.js';
import pino from 'pino';
import type { ServerConfig, ServerContext, ToolResult } from './types.js';

export type ToolHandler<T = unknown> = (
  args: Record<string, unknown>,
  context: ServerContext
) => Promise<ToolResult<T>>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, object>;
    required?: string[];
  };
  handler: ToolHandler;
}

/**
 * Base class for all Reins MCP servers
 */
export abstract class BaseServer {
  protected server: Server;
  protected logger: pino.Logger;
  protected tools: Map<string, ToolDefinition> = new Map();
  protected config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
    this.logger = pino({
      name: config.name,
      level: config.debug ? 'debug' : 'info',
    });

    this.server = new Server(
      {
        name: config.name,
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  /**
   * Register tools for this server - implemented by subclasses
   */
  protected abstract registerTools(): void;

  /**
   * Get context for tool execution - can be overridden by subclasses
   */
  protected async getContext(requestId: string): Promise<ServerContext> {
    return { requestId };
  }

  /**
   * Add a tool to this server
   */
  protected addTool(definition: ToolDefinition): void {
    this.tools.set(definition.name, definition);
    this.logger.debug({ tool: definition.name }, 'Registered tool');
  }

  /**
   * Set up MCP protocol handlers
   */
  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = Array.from(this.tools.values()).map((def) => ({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema as { type: 'object'; properties?: Record<string, object>; required?: string[] },
      }));
      return { tools };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const requestId = crypto.randomUUID();

      this.logger.info({ tool: name, requestId }, 'Tool call received');

      const toolDef = this.tools.get(name);
      if (!toolDef) {
        return this.errorResult(`Unknown tool: ${name}`);
      }

      try {
        const context = await this.getContext(requestId);
        const result = await toolDef.handler(args ?? {}, context);

        if (result.success) {
          this.logger.info({ tool: name, requestId }, 'Tool call succeeded');
          return this.successResult(result.data);
        } else {
          this.logger.warn(
            { tool: name, requestId, error: result.error },
            'Tool call failed'
          );
          return this.errorResult(result.error ?? 'Unknown error');
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        this.logger.error({ tool: name, requestId, error }, 'Tool call threw');
        return this.errorResult(errorMessage);
      }
    });
  }

  /**
   * Format successful result
   */
  protected successResult(data: unknown): CallToolResult {
    const content: TextContent[] = [
      {
        type: 'text',
        text:
          typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ];
    return { content };
  }

  /**
   * Format error result
   */
  protected errorResult(error: string): CallToolResult {
    const content: TextContent[] = [
      {
        type: 'text',
        text: `Error: ${error}`,
      },
    ];
    return { content, isError: true };
  }

  /**
   * Start the server with stdio transport
   */
  async start(): Promise<void> {
    // Register tools before starting
    this.registerTools();

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.logger.info('Server started');
  }

  /**
   * Get list of registered tool names
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get tool definitions for external use (e.g., policy filtering)
   */
  getToolDefinitions(): Array<{
    name: string;
    description: string;
    inputSchema: { type: 'object'; properties: Record<string, object>; required?: string[] };
  }> {
    return Array.from(this.tools.values()).map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
    }));
  }
}
