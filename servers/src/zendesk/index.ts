/**
 * Zendesk MCP Server
 *
 * Provides MCP tools for the Zendesk customer support platform:
 * - zendesk_list_tickets: List tickets with status/sort filters
 * - zendesk_get_ticket: Get a single ticket by ID
 * - zendesk_search_tickets: Search tickets using Zendesk query syntax
 * - zendesk_list_ticket_comments: Full conversation thread for a ticket
 * - zendesk_create_ticket: Create a new support ticket
 * - zendesk_update_ticket: Update status, priority, assignee, or add a comment
 */

import { BaseServer } from '../common/base-server.js';
import type { ServerConfig, ServerContext } from '../common/types.js';
import type { ZendeskContext } from './handlers.js';
import { zendeskTools } from './tools.js';

export interface ZendeskServerConfig extends ServerConfig {
  /** Zendesk API token */
  token?: string;
  /** Agent email address used for Basic auth */
  email?: string;
  /** Zendesk subdomain (e.g. "mycompany" for mycompany.zendesk.com) */
  subdomain?: string;
}

export class ZendeskServer extends BaseServer {
  private token?: string;
  private email?: string;
  private subdomain?: string;

  constructor(config: ZendeskServerConfig) {
    super(config);
    this.token = config.token ?? process.env.ZENDESK_API_TOKEN;
    this.email = config.email ?? process.env.ZENDESK_EMAIL;
    this.subdomain = config.subdomain ?? process.env.ZENDESK_SUBDOMAIN;
  }

  protected registerTools(): void {
    for (const tool of zendeskTools) {
      this.addTool(tool);
    }
  }

  protected async getContext(requestId: string): Promise<ServerContext> {
    const basicAuth = Buffer.from(`${this.email}/token:${this.token}`).toString('base64');
    const context: ZendeskContext = {
      requestId,
      accessToken: this.token,
      basicAuth,
      subdomain: this.subdomain ?? '',
    };
    return context;
  }

  isConfigured(): boolean {
    return !!(this.token && this.email && this.subdomain);
  }

  setCredentials(email: string, token: string, subdomain: string): void {
    this.email = email;
    this.token = token;
    this.subdomain = subdomain;
  }
}

export { zendeskTools } from './tools.js';
export { definition } from './definition.js';
