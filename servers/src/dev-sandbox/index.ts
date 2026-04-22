/**
 * Dev Sandbox MCP Server
 *
 * A fake service for end-to-end testing of the approval flow.
 *
 * - Read tools (sandbox_echo, sandbox_list_items, sandbox_get_item): always allowed
 * - Write tools (sandbox_create_item, sandbox_send_message, sandbox_update_item): require approval
 * - Blocked tools (sandbox_delete_item, sandbox_wipe_all): always denied
 *
 * Auth: accepts any token value (or none). This server is only registered
 * when NODE_ENV !== 'production'.
 */

import { BaseServer } from '../common/base-server.js';
import type { ServerConfig, ServerContext } from '../common/types.js';
import { devSandboxTools } from './tools.js';

export interface DevSandboxServerConfig extends ServerConfig {
  /** Optional token — any value accepted, purely for API compatibility */
  token?: string;
}

export class DevSandboxServer extends BaseServer {
  constructor(config: DevSandboxServerConfig) {
    super(config);
  }

  protected registerTools(): void {
    for (const tool of devSandboxTools) {
      this.addTool(tool);
    }
  }

  protected async getContext(requestId: string): Promise<ServerContext> {
    // No real auth needed — return an empty context
    return { requestId };
  }

  /** Always configured — this server needs no real credentials */
  isConfigured(): boolean {
    return true;
  }
}

export { devSandboxTools } from './tools.js';
export { definition } from './definition.js';
