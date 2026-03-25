/**
 * Google Drive MCP Server
 *
 * Provides MCP tools for Google Drive operations:
 * - drive_list_files: List files in Drive
 * - drive_get_file: Get file metadata
 * - drive_read_file: Read file content
 * - drive_search: Search for files
 * - drive_create_file: Create new file
 * - drive_update_file: Update file content/metadata
 * - drive_share_file: Share a file
 * - drive_delete_file: Delete a file
 * - drive_list_shared_drives: List shared drives
 */

import { BaseServer } from '../common/base-server.js';
import { GoogleOAuthHandler, GoogleScopes, type TokenStorage } from '../common/oauth-handler.js';
import type { ServerConfig, ServerContext, GoogleOAuthConfig } from '../common/types.js';
import { driveTools } from './tools.js';

export interface DriveServerConfig extends ServerConfig {
  /** OAuth configuration for Google */
  oauth?: GoogleOAuthConfig;
  /** Token storage implementation */
  tokenStorage?: TokenStorage;
}

/**
 * Google Drive MCP Server
 */
export class DriveServer extends BaseServer {
  private oauthHandler?: GoogleOAuthHandler;
  private tokenStorage?: TokenStorage;

  constructor(config: DriveServerConfig) {
    super(config);

    if (config.oauth && config.tokenStorage) {
      this.oauthHandler = new GoogleOAuthHandler(config.oauth, config.tokenStorage);
      this.tokenStorage = config.tokenStorage;
    }
  }

  /**
   * Register Drive tools
   */
  protected registerTools(): void {
    for (const tool of driveTools) {
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

    const defaultScopes = [GoogleScopes.Drive.READONLY];

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
export { driveTools } from './tools.js';
export { definition } from './definition.js';
