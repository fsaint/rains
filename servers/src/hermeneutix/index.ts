/**
 * Hermeneutix MCP Server
 *
 * Provides MCP tools for the Hermeneutix meeting transcription platform:
 * - hermeneutix_list_projects: List active projects
 * - hermeneutix_list_meetings: List meetings in a project
 * - hermeneutix_get_meeting_instance: Full instance detail with transcripts
 * - hermeneutix_list_speakers: List project members / speakers
 * - hermeneutix_get_conversation_preview: Preview conversation transcript
 * - hermeneutix_search_profiles: Search speaker profiles
 */

import { BaseServer } from '../common/base-server.js';
import type { ServerConfig, ServerContext } from '../common/types.js';
import { hermeneutixTools } from './tools.js';

export interface HermeneutixServerConfig extends ServerConfig {
  /** Hermeneutix API token */
  token?: string;
}

export class HermeneutixServer extends BaseServer {
  private token?: string;

  constructor(config: HermeneutixServerConfig) {
    super(config);
    this.token = config.token ?? process.env.HERMENEUTIX_API_TOKEN;
  }

  protected registerTools(): void {
    for (const tool of hermeneutixTools) {
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

export { hermeneutixTools } from './tools.js';
export { definition } from './definition.js';
