/**
 * GitHub MCP Server
 *
 * Provides MCP tools for GitHub operations:
 * - github_list_repos, github_get_repo
 * - github_list_issues, github_get_issue, github_create_issue, github_comment_on_issue
 * - github_list_pull_requests, github_get_pull_request, github_get_pull_request_diff
 * - github_get_file_content, github_search_code, github_get_user
 */

import { BaseServer } from '../common/base-server.js';
import type { ServerConfig, ServerContext } from '../common/types.js';
import { githubTools } from './tools.js';

export interface GitHubServerConfig extends ServerConfig {
  /** GitHub Personal Access Token */
  token?: string;
}

/**
 * GitHub MCP Server
 */
export class GitHubServer extends BaseServer {
  private token?: string;

  constructor(config: GitHubServerConfig) {
    super(config);
    this.token = config.token ?? process.env.GITHUB_TOKEN;
  }

  protected registerTools(): void {
    for (const tool of githubTools) {
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

export { githubTools, TOOL_REQUIRED_SCOPES } from './tools.js';
export { validateToken } from './handlers.js';
export { definition } from './definition.js';
