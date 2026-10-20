/**
 * Threads MCP Server
 *
 * Lets an agent keep the user's threads — time-bound focus topics — current:
 * log events, add todos and deadlines, update Now/Next. Thread state lives in
 * the Reins backend; this server only calls /api/threads.
 *
 * Auth: Uses REINS_GATEWAY_TOKEN (x-reins-agent-secret header) to call the backend.
 *
 * thread_propose, thread_close and thread_add_watcher are approval-locked and
 * execute in the backend once the owner approves; their handlers here only refuse.
 */

import { BaseServer } from '../common/base-server.js';
import type { ServerConfig, ServerContext } from '../common/types.js';
import { threadsTools } from './tools.js';

export interface ThreadsServerConfig extends ServerConfig {
  /** Reins backend API URL */
  apiUrl?: string;
  /** Gateway token for authenticating with the backend */
  gatewayToken?: string;
}

export class ThreadsServer extends BaseServer {
  private apiUrl: string;
  private gatewayToken: string;

  constructor(config: ThreadsServerConfig) {
    super(config);
    this.apiUrl = config.apiUrl ?? process.env.REINS_API_URL ?? 'https://app.helm.mom';
    this.gatewayToken = config.gatewayToken ?? process.env.REINS_GATEWAY_TOKEN ?? '';
  }

  protected registerTools(): void {
    for (const tool of threadsTools) {
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

export { threadsTools } from './tools.js';
export { definition } from './definition.js';
