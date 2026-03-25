/**
 * Linear MCP Server
 *
 * Provides MCP tools for Linear project management:
 * - linear_list_workspaces: List connected workspaces
 * - linear_list_issues, linear_get_issue, linear_search_issues
 * - linear_list_teams, linear_list_projects, linear_get_project
 * - linear_list_cycles, linear_list_labels
 * - linear_create_issue, linear_update_issue, linear_comment_on_issue
 * - linear_delete_issue (blocked by default)
 *
 * Supports multiple workspaces, each with its own API key.
 */

import { BaseServer } from '../common/base-server.js';
import type { ServerConfig, ServerContext } from '../common/types.js';
import { linearTools } from './tools.js';

export interface LinearServerConfig extends ServerConfig {
  /** Linear API key */
  token?: string;
}

/**
 * Linear MCP Server
 */
export class LinearServer extends BaseServer {
  private token?: string;

  constructor(config: LinearServerConfig) {
    super(config);
    this.token = config.token ?? process.env.LINEAR_API_KEY;
  }

  protected registerTools(): void {
    for (const tool of linearTools) {
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

export { linearTools } from './tools.js';
export { definition } from './definition.js';
