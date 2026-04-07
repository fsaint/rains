/**
 * Zendesk Service Definition
 */

import type { ServiceDefinitionWithTools } from '../common/types.js';
import { zendeskTools } from './tools.js';

export const definition: ServiceDefinitionWithTools = {
  type: 'zendesk',
  name: 'Zendesk',
  description: 'Customer support platform — browse, search, create, and update support tickets.',
  icon: 'Headphones',
  category: 'productivity',
  toolPrefix: 'zendesk_',
  auth: {
    type: 'api_key',
    required: true,
    instructions: 'Go to Zendesk Admin → Apps & Integrations → Zendesk API → Add API token. You will also need your subdomain (e.g. "mycompany" from mycompany.zendesk.com) and your agent email address.',
    keyUrl: 'https://developer.zendesk.com/api-reference/introduction/security-and-auth/#api-token',
  },
  tools: zendeskTools,
  permissions: {
    read: [
      'zendesk_list_tickets',
      'zendesk_get_ticket',
      'zendesk_search_tickets',
      'zendesk_list_ticket_comments',
    ],
    write: [
      'zendesk_create_ticket',
      'zendesk_update_ticket',
    ],
    blocked: [],
  },
  permissionDescriptions: {
    read: 'Read-only access to tickets and conversations.',
    full: 'Read tickets and create or update tickets on your behalf.',
  },
};
