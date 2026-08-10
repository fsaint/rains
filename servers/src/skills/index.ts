/**
 * Skills MCP Server
 *
 * Serves reusable task playbooks ("skills") authored by the user in the Reins
 * dashboard. Unlike the SKILL.md files baked into the agent images, these live
 * in the backend database and are fetched on demand — so editing one takes
 * effect on the agent's next skills_get call, with no redeploy.
 *
 * Auth: Uses REINS_GATEWAY_TOKEN (x-reins-agent-secret header) to call the backend.
 *
 * Tools:
 * - skills_list: List the skills assigned to this agent, with dependency status
 * - skills_get: Load one skill's full instructions by slug
 */

import { BaseServer } from '../common/base-server.js';
import type { ServerConfig, ServerContext } from '../common/types.js';
import { skillsTools } from './tools.js';

export interface SkillsServerConfig extends ServerConfig {
  /** Reins backend API URL */
  apiUrl?: string;
  /** Gateway token for authenticating with the backend */
  gatewayToken?: string;
}

export class SkillsServer extends BaseServer {
  private apiUrl: string;
  private gatewayToken: string;

  constructor(config: SkillsServerConfig) {
    super(config);
    this.apiUrl = config.apiUrl ?? process.env.REINS_API_URL ?? 'https://app.helm.mom';
    this.gatewayToken = config.gatewayToken ?? process.env.REINS_GATEWAY_TOKEN ?? '';
  }

  protected registerTools(): void {
    for (const tool of skillsTools) {
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

export { skillsTools } from './tools.js';
export { definition } from './definition.js';
