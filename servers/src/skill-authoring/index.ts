/**
 * Skill Authoring MCP Server
 *
 * Lets one privileged "architect" agent write skills and attach them to the
 * other agents on the same account. The read-only `skills` server stays the way
 * every other agent consumes them.
 *
 * Auth: REINS_GATEWAY_TOKEN (x-reins-agent-secret) against the backend, which
 * scopes every write to the calling agent's owner.
 *
 * Tools:
 * - skill_authoring_list:     every skill the owner has, with ids
 * - skill_authoring_create:   author a new skill
 * - skill_authoring_update:   replace an existing one
 * - skill_authoring_assign:   attach a skill to one of the owner's agents
 * - skill_authoring_unassign: detach it again
 */

import { BaseServer } from '../common/base-server.js';
import type { ServerConfig, ServerContext } from '../common/types.js';
import { skillAuthoringTools } from './tools.js';

export interface SkillAuthoringServerConfig extends ServerConfig {
  /** Reins backend API URL */
  apiUrl?: string;
  /** Gateway token for authenticating with the backend */
  gatewayToken?: string;
}

export class SkillAuthoringServer extends BaseServer {
  private apiUrl: string;
  private gatewayToken: string;

  constructor(config: SkillAuthoringServerConfig) {
    super(config);
    this.apiUrl = config.apiUrl ?? process.env.REINS_API_URL ?? 'https://app.helm.mom';
    this.gatewayToken = config.gatewayToken ?? process.env.REINS_GATEWAY_TOKEN ?? '';
  }

  protected registerTools(): void {
    for (const tool of skillAuthoringTools) {
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

export { skillAuthoringTools } from './tools.js';
export { definition } from './definition.js';
