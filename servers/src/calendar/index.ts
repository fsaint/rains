/**
 * Google Calendar MCP Server
 *
 * Provides MCP tools for Google Calendar operations:
 * - calendar_list_events: List upcoming events
 * - calendar_get_event: Get event details
 * - calendar_search_events: Search events by query
 * - calendar_create_event: Create new event
 * - calendar_update_event: Update existing event
 * - calendar_delete_event: Delete event
 * - calendar_list_calendars: List available calendars
 * - calendar_get_free_busy: Get free/busy information
 */

import { BaseServer } from '../common/base-server.js';
import { GoogleOAuthHandler, GoogleScopes, type TokenStorage } from '../common/oauth-handler.js';
import type { ServerConfig, ServerContext, GoogleOAuthConfig } from '../common/types.js';
import { calendarTools } from './tools.js';

export interface CalendarServerConfig extends ServerConfig {
  /** OAuth configuration for Google */
  oauth?: GoogleOAuthConfig;
  /** Token storage implementation */
  tokenStorage?: TokenStorage;
}

/**
 * Google Calendar MCP Server
 */
export class CalendarServer extends BaseServer {
  private oauthHandler?: GoogleOAuthHandler;
  private tokenStorage?: TokenStorage;

  constructor(config: CalendarServerConfig) {
    super(config);

    if (config.oauth && config.tokenStorage) {
      this.oauthHandler = new GoogleOAuthHandler(config.oauth, config.tokenStorage);
      this.tokenStorage = config.tokenStorage;
    }
  }

  /**
   * Register Calendar tools
   */
  protected registerTools(): void {
    for (const tool of calendarTools) {
      this.addTool(tool);
    }
  }

  /**
   * Get context with access token
   */
  protected async getContext(requestId: string): Promise<ServerContext> {
    const context: ServerContext = { requestId };

    if (this.oauthHandler && this.config.credentialId) {
      try {
        context.accessToken = await this.oauthHandler.getAccessToken(
          this.config.credentialId
        );
      } catch (error) {
        this.logger.warn({ error }, 'Failed to get access token');
      }
    }

    return context;
  }

  /**
   * Get OAuth authorization URL
   */
  async getAuthUrl(scopes?: string[]): Promise<string> {
    if (!this.oauthHandler) {
      throw new Error('OAuth not configured');
    }

    const defaultScopes = [GoogleScopes.Calendar.READONLY];

    return this.oauthHandler.getAuthUrl(
      scopes ?? defaultScopes,
      this.config.credentialId
    );
  }

  /**
   * Handle OAuth callback
   */
  async handleOAuthCallback(code: string): Promise<void> {
    if (!this.oauthHandler || !this.config.credentialId) {
      throw new Error('OAuth not configured');
    }

    await this.oauthHandler.handleCallback(code, this.config.credentialId);
  }

  /**
   * Check if server has valid credentials
   */
  async hasValidCredentials(): Promise<boolean> {
    if (!this.oauthHandler || !this.config.credentialId || !this.tokenStorage) {
      return false;
    }

    const tokens = await this.tokenStorage.getTokens(this.config.credentialId);
    return !!tokens?.accessToken;
  }
}

// Re-export tools and definition for external use
export { calendarTools } from './tools.js';
export { definition } from './definition.js';
