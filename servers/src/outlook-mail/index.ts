/**
 * Outlook Mail MCP Server
 *
 * Provides MCP tools for Outlook email operations via Microsoft Graph API:
 * - outlook_mail_get_profile: Get authenticated user profile
 * - outlook_mail_list_messages: List messages with optional filtering
 * - outlook_mail_get_message: Get full message content
 * - outlook_mail_search: Search emails
 * - outlook_mail_list_folders: List mail folders
 * - outlook_mail_create_draft: Create a draft email
 * - outlook_mail_send_draft: Send an existing draft
 * - outlook_mail_send_message: Send email directly (blocked by default)
 * - outlook_mail_reply: Reply to a message
 * - outlook_mail_move_message: Move message to another folder
 * - outlook_mail_delete_message: Delete a message (blocked by default)
 */

import { BaseServer } from '../common/base-server.js';
import type { ServerConfig, ServerContext } from '../common/types.js';
import { outlookMailTools } from './tools.js';

export interface OutlookMailServerConfig extends ServerConfig {
  /** Microsoft OAuth2 access token */
  token?: string;
}

/**
 * Outlook Mail MCP Server
 */
export class OutlookMailServer extends BaseServer {
  private token?: string;

  constructor(config: OutlookMailServerConfig) {
    super(config);
    this.token = config.token;
  }

  protected registerTools(): void {
    for (const tool of outlookMailTools) {
      this.addTool(tool);
    }
  }

  protected async getContext(requestId: string): Promise<ServerContext> {
    return {
      requestId,
      accessToken: this.token,
    };
  }

  isConfigured(): boolean {
    return !!this.token;
  }

  setToken(token: string): void {
    this.token = token;
  }
}

export { outlookMailTools } from './tools.js';
export { validateToken } from './handlers.js';
export { definition } from './definition.js';
