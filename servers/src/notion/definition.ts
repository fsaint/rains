import type { ServiceDefinitionWithTools } from '../common/types.js';
import { notionTools } from './tools.js';

export const definition: ServiceDefinitionWithTools = {
  type: 'notion',
  name: 'Notion',
  description: 'Search, query, and manage Notion databases and pages',
  icon: 'BookOpen',
  category: 'productivity',
  toolPrefix: 'notion_',
  auth: {
    type: 'api_key',
    required: true,
    instructions: 'Create an internal integration at Notion Settings > My Integrations. Then share your databases with the integration.',
    keyUrl: 'https://www.notion.so/my-integrations',
  },
  tools: notionTools,
  permissions: {
    read: [
      'notion_search',
      'notion_get_database',
      'notion_query_database',
      'notion_get_page',
      'notion_get_page_content',
    ],
    write: [
      'notion_create_page',
      'notion_update_page',
    ],
    blocked: [
      'notion_archive_page',
    ],
  },
  permissionDescriptions: {
    read: 'Search, view databases, and read pages',
    full: 'Read freely. Creating and updating pages require your approval.',
  },
};
