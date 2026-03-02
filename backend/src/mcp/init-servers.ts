/**
 * Native Server Initialization
 *
 * Initializes and registers all native MCP servers with the ServerManager.
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
  serverType: 'gmail' | 'drive' | 'calendar' | 'web-search' | 'browser',
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
      });
    },
  };
}

/**
 * Initialize all native servers
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

  // Check if Google OAuth is configured
  const googleOAuthConfigured = !!(config.googleClientId && config.googleClientSecret);
  if (!googleOAuthConfigured) {
    logger.warn('Google OAuth not configured - Gmail, Drive, Calendar servers will have limited functionality');
    logger.warn('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable OAuth');
  }

  // Initialize Gmail server
  try {
    const { gmailTools } = servers;
    const gmailWrapper = createServerWrapper('gmail', 'Gmail Server', gmailTools);
    serverManager.registerServer(gmailWrapper);
    logger.info('Gmail server registered');
  } catch (error) {
    logger.error({ error }, 'Failed to initialize Gmail server');
  }

  // Initialize Drive server
  try {
    const { driveTools } = servers;
    const driveWrapper = createServerWrapper('drive', 'Google Drive Server', driveTools);
    serverManager.registerServer(driveWrapper);
    logger.info('Drive server registered');
  } catch (error) {
    logger.error({ error }, 'Failed to initialize Drive server');
  }

  // Initialize Calendar server
  try {
    const { calendarTools } = servers;
    const calendarWrapper = createServerWrapper('calendar', 'Google Calendar Server', calendarTools);
    serverManager.registerServer(calendarWrapper);
    logger.info('Calendar server registered');
  } catch (error) {
    logger.error({ error }, 'Failed to initialize Calendar server');
  }

  // Initialize Web Search server
  try {
    const { webSearchTools } = servers;

    if (!config.braveApiKey) {
      logger.warn('BRAVE_API_KEY not set - Web Search server will not be functional');
    }

    const webSearchWrapper = createServerWrapper(
      'web-search',
      'Web Search Server',
      webSearchTools,
      () => config.braveApiKey
    );
    serverManager.registerServer(webSearchWrapper);
    logger.info('Web Search server registered');
  } catch (error) {
    logger.error({ error }, 'Failed to initialize Web Search server');
  }

  // Initialize Browser server
  try {
    const { BrowserServer, browserTools } = servers;
    const browserServer = new BrowserServer({
      serverId: 'browser',
      name: 'Browser Server',
      browserConfig: {
        maxInstances: config.browserMaxInstances,
        idleTimeout: config.browserIdleTimeout,
      },
    });

    // Store reference for cleanup
    browserSessionManager = browserServer.getSessionManager();

    // Start the session manager
    browserSessionManager.start();

    const browserWrapper = createServerWrapper('browser', 'Browser Automation Server', browserTools);
    serverManager.registerServer(browserWrapper);
    logger.info('Browser server registered');
  } catch (error) {
    logger.error({ error }, 'Failed to initialize Browser server');
  }

  const status = await serverManager.getStatus();
  logger.info({ servers: status.map((s) => s.serverType) }, 'Native servers initialized');
}

/**
 * Shutdown native servers gracefully
 */
export async function shutdownNativeServers(): Promise<void> {
  logger.info('Shutting down native servers...');

  // Close browser sessions
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
