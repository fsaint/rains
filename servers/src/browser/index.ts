/**
 * Headless Browser MCP Server (Playwright)
 *
 * Provides MCP tools for browser automation:
 * - browser_create_session: Create new browser session
 * - browser_navigate: Navigate to URL
 * - browser_screenshot: Capture page screenshot
 * - browser_get_content: Extract page content
 * - browser_click: Click elements
 * - browser_type: Type into inputs
 * - browser_evaluate: Execute JavaScript
 * - browser_scroll: Scroll page
 * - browser_wait_for_selector: Wait for elements
 * - browser_close_session: Close session
 * - browser_list_sessions: List active sessions
 */

import { BaseServer } from '../common/base-server.js';
import type { ServerConfig, BrowserConfig } from '../common/types.js';
import { BrowserSessionManager } from './session-manager.js';
import { browserTools } from './tools.js';
import { setSessionManager } from './handlers.js';

export interface BrowserServerConfig extends ServerConfig {
  /** Browser configuration */
  browserConfig?: BrowserConfig;
}

/**
 * Headless Browser MCP Server using Playwright
 */
export class BrowserServer extends BaseServer {
  private sessionManager: BrowserSessionManager;

  constructor(config: BrowserServerConfig) {
    super(config);

    this.sessionManager = new BrowserSessionManager(config.browserConfig);
    setSessionManager(this.sessionManager);
  }

  /**
   * Register Browser tools
   */
  protected registerTools(): void {
    for (const tool of browserTools) {
      this.addTool(tool);
    }
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    this.sessionManager.start();
    await super.start();
  }

  /**
   * Stop the server and cleanup
   */
  async stop(): Promise<void> {
    await this.sessionManager.stop();
  }

  /**
   * Get active session count
   */
  get sessionCount(): number {
    return this.sessionManager.sessionCount;
  }

  /**
   * Get session manager for external access
   */
  getSessionManager(): BrowserSessionManager {
    return this.sessionManager;
  }
}

// Re-export for external use
export { BrowserSessionManager } from './session-manager.js';
export { browserTools } from './tools.js';
export { definition } from './definition.js';
