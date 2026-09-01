import type { ServiceDefinitionWithTools } from '../common/types.js';
import { skillsTools } from './tools.js';

export const definition: ServiceDefinitionWithTools = {
  type: 'skills',
  name: 'Skills',
  description: 'Reusable task playbooks authored in the Helm dashboard — listed and loaded on demand',
  icon: 'BookOpen',
  category: 'productivity',
  toolPrefix: 'skills_',
  auth: {
    type: 'none',
    required: false,
  },
  tools: skillsTools,
  permissions: {
    // All three tools are read-only, so no approval flow is ever triggered.
    read: [
      'skills_list',
      'skills_get',
      'skills_list_library',
    ],
    write: [],
    defaultWritePermission: 'allow',
    blocked: [],
  },
  permissionDescriptions: {
    read: "Read the skills assigned to this agent and browse the owner's library",
    full: "Read the skills assigned to this agent and browse the owner's library",
  },
};
