/**
 * Native Server Initialization
 *
 * Initializes and registers all native MCP servers from the service registry.
 */

import pino from 'pino';
import { config } from '../config/index.js';
import { serverManager, type NativeServer, type NativeServerTool, type ToolContext, type ToolResult } from './server-manager.js';
import type { ToolDefinition } from '@reins/servers';

const logger = pino({ name: 'init-servers' });

/**
 * Browser session manager reference for cleanup
 */
let browserSessionManager: { start: () => void; stop: () => Promise<void> } | null = null;

/**
 * Create a wrapper that implements NativeServer interface
 */
function createServerWrapper(
  serverType: string,
  name: string,
  tools: ToolDefinition[],
  getAccessToken?: () => string | undefined
): NativeServer {
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  return {
    serverType,
    name,
    getToolDefinitions(): NativeServerTool[] {
      return tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    },
    async callTool(toolName: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const tool = toolMap.get(toolName);
      if (!tool) {
        return { success: false, error: `Unknown tool: ${toolName}` };
      }

      return tool.handler(args, {
        requestId: context.requestId,
        accessToken: getAccessToken?.() ?? context.accessToken,
        agentId: context.agentId,
        linkedAccounts: context.linkedAccounts,
        driveDefaultLevel: context.driveDefaultLevel,
        drivePathRules: context.drivePathRules,
      });
    },
  };
}

/**
 * Initialize all native servers from the service registry
 */
export async function initializeNativeServers(): Promise<void> {
  let servers: typeof import('@reins/servers');

  try {
    servers = await import('@reins/servers');
  } catch (error) {
    logger.warn('Could not import @reins/servers - native servers will not be available');
    logger.warn('Run "npm run build" in the servers workspace to enable native servers');
    return;
  }

  logger.info('Initializing native MCP servers...');

  for (const def of servers.serviceDefinitions) {
    try {
      // Special handling for browser (needs session manager)
      if (def.type === 'browser') {
        const { BrowserServer } = servers;
        const browserServer = new BrowserServer({
          serverId: 'browser',
          name: def.name,
          browserConfig: {
            maxInstances: config.browserMaxInstances,
            idleTimeout: config.browserIdleTimeout,
          },
        });

        browserSessionManager = browserServer.getSessionManager();
        browserSessionManager.start();

        const wrapper = createServerWrapper(def.type, def.name, def.tools);
        serverManager.registerServer(wrapper);
        logger.info(`${def.name} server registered`);
        continue;
      }

      // Special handling for web-search (needs API key warning)
      if (def.type === 'web-search') {
        if (!config.braveApiKey) {
          logger.warn('BRAVE_API_KEY not set - Web Search server will not be functional');
        }

        const wrapper = createServerWrapper(
          def.type,
          def.name,
          def.tools,
          () => config.braveApiKey
        );
        serverManager.registerServer(wrapper);
        logger.info(`${def.name} server registered`);
        continue;
      }

      // Default: register tools directly
      const wrapper = createServerWrapper(def.type, def.name, def.tools);
      serverManager.registerServer(wrapper);
      logger.info(`${def.name} server registered`);
    } catch (error) {
      logger.error({ error, service: def.type }, `Failed to initialize ${def.name}`);
    }
  }

  const status = await serverManager.getStatus();
  logger.info({ servers: status.map((s) => s.serverType) }, 'Native servers initialized');
}

/**
 * Shutdown native servers gracefully
 */
export async function shutdownNativeServers(): Promise<void> {
  logger.info('Shutting down native servers...');

  if (browserSessionManager) {
    try {
      await browserSessionManager.stop();
      logger.info('Browser sessions closed');
    } catch (error) {
      logger.error({ error }, 'Error closing browser sessions');
    }
  }

  logger.info('Native servers shutdown complete');
}
