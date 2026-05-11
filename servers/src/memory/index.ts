/**
 * Memory MCP Server
 *
 * Provides persistent, Obsidian-like memory for AI agents.
 * Entries are stored in the Reins backend database (shared vault per user).
 *
 * Auth: Uses REINS_GATEWAY_TOKEN (x-reins-agent-secret header) to call the backend.
 *
 * Tools:
 * - memory_get_root: Load the memory index at conversation start
 * - memory_create: Create a new entry (note, person, company, project)
 * - memory_update: Update entry content, title, or type
 * - memory_search: Full-text search across the vault
 * - memory_list: List entries by type or parent
 * - memory_get: Get a single entry with attributes and backlinks
 * - memory_relate: Create a named relation between two entries
 * - memory_delete: Soft-delete an entry
 */

import { BaseServer } from '../common/base-server.js';
import type { ServerConfig, ServerContext } from '../common/types.js';
import { memoryTools } from './tools.js';

export interface MemoryServerConfig extends ServerConfig {
  /** Reins backend API URL */
  apiUrl?: string;
  /** Gateway token for authenticating with the backend */
  gatewayToken?: string;
}

export class MemoryServer extends BaseServer {
  private apiUrl: string;
  private gatewayToken: string;

  constructor(config: MemoryServerConfig) {
    super(config);
    this.apiUrl = config.apiUrl ?? process.env.REINS_API_URL ?? 'https://app.agenthelm.mom';
    this.gatewayToken = config.gatewayToken ?? process.env.REINS_GATEWAY_TOKEN ?? '';
  }

  protected registerTools(): void {
    for (const tool of memoryTools) {
      this.addTool(tool);
    }
  }

  protected async getContext(requestId: string): Promise<ServerContext & { gatewayToken: string; apiUrl: string }> {
    return {
      requestId,
      gatewayToken: this.gatewayToken,
      apiUrl: this.apiUrl,
    };
  }

  isConfigured(): boolean {
    return true; // No credentials required — uses gateway token from env
  }
}

export { memoryTools } from './tools.js';
export { definition } from './definition.js';
