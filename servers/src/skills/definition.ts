import type { ServiceDefinitionWithTools } from '../common/types.js';
import { skillsTools } from './tools.js';

export const definition: ServiceDefinitionWithTools = {
  type: 'skills',
  name: 'Skills',
  description: 'Reusable task playbooks authored in the Reins dashboard — listed and loaded on demand',
  icon: 'BookOpen',
  category: 'productivity',
  toolPrefix: 'skills_',
  auth: {
    type: 'none',
    required: false,
  },
  tools: skillsTools,
  permissions: {
    // Both tools are read-only, so no approval flow is ever triggered.
    read: [
      'skills_list',
      'skills_get',
    ],
    write: [],
    defaultWritePermission: 'allow',
    blocked: [],
  },
  permissionDescriptions: {
    read: 'Read the skills assigned to this agent',
    full: 'Read the skills assigned to this agent',
  },
};
