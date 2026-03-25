import type { ServiceDefinitionWithTools } from '../common/types.js';
import { webSearchTools } from './tools.js';

export const definition: ServiceDefinitionWithTools = {
  type: 'web-search',
  name: 'Web Search',
  description: 'Search the web via Brave Search API',
  icon: 'Search',
  category: 'search',
  toolPrefix: 'web_search',
  auth: {
    type: 'api_key',
    required: false,
    instructions: 'Get a Brave Search API key (free tier: 1000 queries/month)',
    keyUrl: 'https://api.search.brave.com/app/keys',
  },
  tools: webSearchTools,
  permissions: {
    read: ['web_search', 'web_search_news', 'web_search_images'],
    write: [],
    blocked: [],
  },
  permissionDescriptions: {
    read: 'Search the web',
    full: 'Full search access',
  },
};
