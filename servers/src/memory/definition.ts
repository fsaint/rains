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
      'memory_dream',
      'memory_list_tags',
      'memory_list_scopes',
    ],
    write: [
      'memory_create',
      'memory_update',
      'memory_relate',
      'memory_set_parent',
      'memory_add_attribute',
      'memory_remove_attribute',
      // Creating a scope is the one write that reshapes the vault rather than
      // adding to it, and it cannot be undone from here — there is no
      // agent-facing delete. The backend caps the count and refuses
      // near-duplicate slugs; consider an explicit require_approval override
      // if agents turn out to reach for it too readily.
      'memory_create_scope',
    ],
    defaultWritePermission: 'allow',
    blocked: [
      'memory_delete',
    ],
  },
  permissionDescriptions: {
    read: 'Read and search the memory vault, across every scope this agent can reach',
    full: 'Read and write to the memory vault freely, and create new scopes. No approval required.',
  },
};
