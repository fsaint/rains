/**
 * Pipedrive MCP Server
 *
 * Provides MCP tools for the Pipedrive CRM platform:
 *
 * Deals:         pipedrive_list_deals, pipedrive_get_deal, pipedrive_search_deals,
 *                pipedrive_create_deal, pipedrive_update_deal, pipedrive_delete_deal
 *
 * Persons:       pipedrive_list_persons, pipedrive_get_person, pipedrive_search_persons,
 *                pipedrive_create_person, pipedrive_update_person, pipedrive_delete_person
 *
 * Organizations: pipedrive_list_organizations, pipedrive_get_organization, pipedrive_search_organizations,
 *                pipedrive_create_organization, pipedrive_update_organization, pipedrive_delete_organization
 *
 * Leads:         pipedrive_list_leads, pipedrive_get_lead,
 *                pipedrive_create_lead, pipedrive_update_lead, pipedrive_delete_lead
 *
 * Activities:    pipedrive_list_activities, pipedrive_get_activity,
 *                pipedrive_create_activity, pipedrive_update_activity, pipedrive_delete_activity
 *
 * Notes:         pipedrive_list_notes, pipedrive_get_note,
 *                pipedrive_create_note, pipedrive_update_note, pipedrive_delete_note
 *
 * Pipelines:     pipedrive_list_pipelines, pipedrive_get_pipeline
 * Stages:        pipedrive_list_stages, pipedrive_get_stage
 *
 * Products:      pipedrive_list_products, pipedrive_get_product,
 *                pipedrive_create_product, pipedrive_update_product, pipedrive_delete_product
 *
 * Search:        pipedrive_search
 * Users:         pipedrive_list_users, pipedrive_get_current_user
 */

import { BaseServer } from '../common/base-server.js';
import type { ServerConfig, ServerContext } from '../common/types.js';
import type { PipedriveContext } from './handlers.js';
import { pipedriveTools } from './tools.js';

export interface PipedriveServerConfig extends ServerConfig {
  /** Pipedrive Personal API token */
  token?: string;
  /** Company domain, e.g. "mycompany" from mycompany.pipedrive.com */
  companydomain?: string;
}

export class PipedriveServer extends BaseServer {
  private token?: string;
  private companydomain?: string;

  constructor(config: PipedriveServerConfig) {
    super(config);
    this.token = config.token ?? process.env.PIPEDRIVE_API_TOKEN;
    this.companydomain = config.companydomain ?? process.env.PIPEDRIVE_COMPANY_DOMAIN;
  }

  protected registerTools(): void {
    for (const tool of pipedriveTools) {
      this.addTool(tool);
    }
  }

  protected async getContext(requestId: string): Promise<ServerContext> {
    const context: PipedriveContext = {
      requestId,
      accessToken: this.token,
      companydomain: this.companydomain ?? '',
    };
    return context;
  }

  isConfigured(): boolean {
    return !!(this.token && this.companydomain);
  }

  setCredentials(token: string, companydomain: string): void {
    this.token = token;
    this.companydomain = companydomain;
  }
}

export { pipedriveTools } from './tools.js';
export { definition } from './definition.js';
