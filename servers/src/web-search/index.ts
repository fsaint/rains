/**
 * Web Search MCP Server (Brave Search API)
 *
 * Provides MCP tools for web search operations:
 * - web_search: General web search
 * - web_search_news: News-specific search
 * - web_search_images: Image search
 * - web_search_suggest: Search suggestions/autocomplete
 *
 * Requires a Brave Search API key. Free tier includes 1000 queries/month.
 * Get your API key at: https://api.search.brave.com/app/keys
 */

import { BaseServer } from '../common/base-server.js';
import type { ServerConfig, ServerContext, BraveSearchConfig } from '../common/types.js';
import { webSearchTools } from './tools.js';

export interface WebSearchServerConfig extends ServerConfig {
  /** Brave Search API configuration */
  braveConfig?: BraveSearchConfig;
}

/**
 * Web Search MCP Server using Brave Search API
 */
export class WebSearchServer extends BaseServer {
  private apiKey?: string;

  constructor(config: WebSearchServerConfig) {
    super(config);

    this.apiKey = config.braveConfig?.apiKey ?? process.env.BRAVE_API_KEY;
  }

  /**
   * Register Web Search tools
   */
  protected registerTools(): void {
    for (const tool of webSearchTools) {
      this.addTool(tool);
    }
  }

  /**
   * Get context with API key
   */
  protected async getContext(requestId: string): Promise<ServerContext> {
    const context: ServerContext = {
      requestId,
      accessToken: this.apiKey,
    };
    return context;
  }

  /**
   * Check if API key is configured
   */
  isConfigured(): boolean {
    return !!this.apiKey;
  }

  /**
   * Set API key at runtime
   */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }
}

// Re-export tools for external use
export { webSearchTools } from './tools.js';
