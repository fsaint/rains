/**
 * Pipedrive Service Definition
 */

import type { ServiceDefinitionWithTools } from '../common/types.js';
import { pipedriveTools } from './tools.js';

export const definition: ServiceDefinitionWithTools = {
  type: 'pipedrive',
  name: 'Pipedrive',
  description: 'CRM platform — manage deals, contacts, organizations, leads, activities, notes, and products across your sales pipeline.',
  icon: 'TrendingUp',
  category: 'productivity',
  toolPrefix: 'pipedrive_',
  auth: {
    type: 'api_key',
    required: true,
    instructions: 'Go to Pipedrive → Settings → Personal preferences → API. Copy your Personal API token. You will also need your company domain (e.g. "mycompany" from mycompany.pipedrive.com).',
    keyUrl: 'https://app.pipedrive.com/settings/api',
  },
  tools: pipedriveTools,
  permissions: {
    read: [
      // Deals
      'pipedrive_list_deals',
      'pipedrive_get_deal',
      'pipedrive_search_deals',
      'pipedrive_list_deal_participants',
      'pipedrive_list_deal_products',
      'pipedrive_list_deal_activities',
      'pipedrive_list_deal_notes',
      // Persons
      'pipedrive_list_persons',
      'pipedrive_get_person',
      'pipedrive_search_persons',
      'pipedrive_list_person_deals',
      // Organizations
      'pipedrive_list_organizations',
      'pipedrive_get_organization',
      'pipedrive_search_organizations',
      'pipedrive_list_organization_deals',
      'pipedrive_list_organization_persons',
      'pipedrive_list_org_relationships',
      // Leads
      'pipedrive_list_leads',
      'pipedrive_get_lead',
      'pipedrive_get_lead_conversion_status',
      // Activities
      'pipedrive_list_activities',
      'pipedrive_get_activity',
      'pipedrive_list_activity_types',
      // Notes
      'pipedrive_list_notes',
      'pipedrive_get_note',
      // Pipelines & Stages
      'pipedrive_list_pipelines',
      'pipedrive_get_pipeline',
      'pipedrive_list_stages',
      'pipedrive_get_stage',
      // Products
      'pipedrive_list_products',
      'pipedrive_get_product',
      // Fields
      'pipedrive_list_deal_fields',
      'pipedrive_list_person_fields',
      'pipedrive_list_organization_fields',
      'pipedrive_list_product_fields',
      // Currencies & Filters
      'pipedrive_list_currencies',
      'pipedrive_list_filters',
      'pipedrive_get_filter',
      // Goals
      'pipedrive_list_goals',
      // Projects & Tasks
      'pipedrive_list_projects',
      'pipedrive_get_project',
      'pipedrive_list_tasks',
      'pipedrive_get_task',
      // Files
      'pipedrive_list_files',
      'pipedrive_get_file',
      // Webhooks
      'pipedrive_list_webhooks',
      // Search & Users
      'pipedrive_search',
      'pipedrive_list_users',
      'pipedrive_get_current_user',
    ],
    write: [
      // Deals
      'pipedrive_create_deal',
      'pipedrive_update_deal',
      'pipedrive_add_deal_participant',
      'pipedrive_add_deal_product',
      'pipedrive_update_deal_product',
      // Persons
      'pipedrive_create_person',
      'pipedrive_update_person',
      // Organizations
      'pipedrive_create_organization',
      'pipedrive_update_organization',
      'pipedrive_create_org_relationship',
      // Leads
      'pipedrive_create_lead',
      'pipedrive_update_lead',
      'pipedrive_convert_lead',
      // Activities
      'pipedrive_create_activity',
      'pipedrive_update_activity',
      // Notes
      'pipedrive_create_note',
      'pipedrive_update_note',
      // Pipelines & Stages
      'pipedrive_create_pipeline',
      'pipedrive_update_pipeline',
      'pipedrive_create_stage',
      'pipedrive_update_stage',
      // Products
      'pipedrive_create_product',
      'pipedrive_update_product',
      // Goals
      'pipedrive_create_goal',
      'pipedrive_update_goal',
      // Projects & Tasks
      'pipedrive_create_project',
      'pipedrive_update_project',
      'pipedrive_create_task',
      'pipedrive_update_task',
      // Webhooks
      'pipedrive_create_webhook',
    ],
    blocked: [
      'pipedrive_delete_deal',
      'pipedrive_delete_person',
      'pipedrive_delete_organization',
      'pipedrive_delete_lead',
      'pipedrive_delete_activity',
      'pipedrive_delete_note',
      'pipedrive_delete_pipeline',
      'pipedrive_delete_stage',
      'pipedrive_delete_product',
      'pipedrive_delete_deal_participant',
      'pipedrive_delete_deal_product',
      'pipedrive_delete_filter',
      'pipedrive_delete_goal',
      'pipedrive_delete_project',
      'pipedrive_delete_task',
      'pipedrive_delete_webhook',
      'pipedrive_delete_org_relationship',
      'pipedrive_delete_file',
    ],
  },
  permissionDescriptions: {
    read: 'Read-only access to all CRM data: deals, contacts, organizations, leads, activities, notes, products, pipelines, projects, tasks, goals, files, webhooks, and field definitions.',
    full: 'Full read/write access to all CRM data — create and update deals, contacts, leads, activities, notes, pipelines, projects, tasks, goals, and webhooks. All delete operations are blocked by default.',
  },
};
