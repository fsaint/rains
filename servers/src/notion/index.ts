/**
 * Notion MCP Server
 *
 * Provides MCP tools for Notion operations via the Notion API:
 * - notion_search: Search databases and pages
 * - notion_get_database: Get database schema
 * - notion_query_database: Query database rows with filters/sorts
 * - notion_get_page: Get a page and its properties
 * - notion_get_page_content: Get page content blocks
 * - notion_create_page: Create a new database row
 * - notion_update_page: Update page properties
 * - notion_archive_page: Archive a page (blocked by default)
 */

import { BaseServer } from '../common/base-server.js';
import type { ServerConfig, ServerContext } from '../common/types.js';
import { notionTools } from './tools.js';

export interface NotionServerConfig extends ServerConfig {
  /** Notion internal integration token */
  token?: string;
}

/**
 * Notion MCP Server
 */
export class NotionServer extends BaseServer {
  private token?: string;

  constructor(config: NotionServerConfig) {
    super(config);
    this.token = config.token ?? process.env.NOTION_TOKEN;
  }

  protected registerTools(): void {
    for (const tool of notionTools) {
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

export { notionTools } from './tools.js';
export { validateToken } from './handlers.js';
export { definition } from './definition.js';
