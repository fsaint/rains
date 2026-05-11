import type { ServiceDefinitionWithTools } from '../common/types.js';
import { memoryTools } from './tools.js';

export const definition: ServiceDefinitionWithTools = {
  type: 'memory',
  name: 'Memory',
  description: 'Persistent knowledge base — create, search, and navigate memory entries across conversations',
  icon: 'Brain',
  category: 'productivity',
  toolPrefix: 'memory_',
  auth: {
    type: 'none',
    required: false,
  },
  tools: memoryTools,
  permissions: {
    read: [
      'memory_get_root',
      'memory_search',
      'memory_list',
      'memory_get',
    ],
    write: [
      'memory_create',
      'memory_update',
      'memory_relate',
    ],
    blocked: [
      'memory_delete',
    ],
  },
  permissionDescriptions: {
    read: 'Read and search the memory vault',
    full: 'Read freely. Creating and updating memory entries require your approval.',
  },
};
