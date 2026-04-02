/**
 * Outlook Calendar MCP Server
 *
 * Provides MCP tools for Outlook calendar operations via Microsoft Graph API:
 * - outlook_cal_list_calendars: List all calendars
 * - outlook_cal_list_events: List events with date range filtering
 * - outlook_cal_get_event: Get event details
 * - outlook_cal_search_events: Search events by keyword
 * - outlook_cal_get_free_busy: Check free/busy availability
 * - outlook_cal_create_event: Create a new event
 * - outlook_cal_update_event: Update an existing event
 * - outlook_cal_respond_to_event: Accept/decline invitations
 * - outlook_cal_delete_event: Delete an event (blocked by default)
 */

import { BaseServer } from '../common/base-server.js';
import type { ServerConfig, ServerContext } from '../common/types.js';
import { outlookCalendarTools } from './tools.js';

export interface OutlookCalendarServerConfig extends ServerConfig {
  /** Microsoft OAuth2 access token */
  token?: string;
}

/**
 * Outlook Calendar MCP Server
 */
export class OutlookCalendarServer extends BaseServer {
  private token?: string;

  constructor(config: OutlookCalendarServerConfig) {
    super(config);
    this.token = config.token;
  }

  protected registerTools(): void {
    for (const tool of outlookCalendarTools) {
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

export { outlookCalendarTools } from './tools.js';
export { definition } from './definition.js';
