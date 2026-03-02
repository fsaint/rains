/**
 * Gmail MCP Server
 *
 * Provides MCP tools for Gmail operations:
 * - gmail_list_messages: List messages with optional search
 * - gmail_get_message: Get full message content
 * - gmail_search: Advanced search with Gmail operators
 * - gmail_create_draft: Create a draft email
 * - gmail_send_draft: Send an existing draft
 * - gmail_send_message: Send email directly (blocked by default)
 * - gmail_delete_message: Delete a message (blocked by default)
 * - gmail_list_labels: List all labels
 */

import { BaseServer } from '../common/base-server.js';
import { GoogleOAuthHandler, GoogleScopes, type TokenStorage } from '../common/oauth-handler.js';
import type { ServerConfig, ServerContext, GoogleOAuthConfig } from '../common/types.js';
import { gmailTools } from './tools.js';

export interface GmailServerConfig extends ServerConfig {
  /** OAuth configuration for Google */
  oauth?: GoogleOAuthConfig;
  /** Token storage implementation */
  tokenStorage?: TokenStorage;
}

/**
 * Gmail MCP Server
 */
export class GmailServer extends BaseServer {
  private oauthHandler?: GoogleOAuthHandler;
  private tokenStorage?: TokenStorage;

  constructor(config: GmailServerConfig) {
    super(config);

    if (config.oauth && config.tokenStorage) {
      this.oauthHandler = new GoogleOAuthHandler(config.oauth, config.tokenStorage);
      this.tokenStorage = config.tokenStorage;
    }
  }

  /**
   * Register Gmail tools
   */
  protected registerTools(): void {
    for (const tool of gmailTools) {
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

    const defaultScopes = [
      GoogleScopes.Gmail.READONLY,
      GoogleScopes.Gmail.COMPOSE,
    ];

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

// Re-export tools for external use
export { gmailTools } from './tools.js';
