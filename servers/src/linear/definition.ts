import type { ServiceDefinitionWithTools } from '../common/types.js';
import { linearTools } from './tools.js';

export const definition: ServiceDefinitionWithTools = {
  type: 'linear',
  name: 'Linear',
  description: 'Issue tracking, project management, and team workflows',
  icon: 'SquareKanban',
  category: 'dev-tools',
  toolPrefix: 'linear_',
  auth: {
    type: 'api_key',
    required: true,
    instructions: 'Create a Personal API Key in Linear Settings > Account > API. Each workspace requires its own key.',
    keyUrl: 'https://linear.app/settings/api',
  },
  tools: linearTools,
  permissions: {
    read: [
      'linear_list_workspaces',
      'linear_list_issues',
      'linear_get_issue',
      'linear_search_issues',
      'linear_list_teams',
      'linear_list_projects',
      'linear_get_project',
      'linear_list_cycles',
      'linear_list_labels',
    ],
    write: [
      'linear_create_issue',
      'linear_update_issue',
      'linear_comment_on_issue',
    ],
    blocked: [
      'linear_delete_issue',
    ],
  },
  permissionDescriptions: {
    read: 'List and read issues, projects, teams, cycles, and labels',
    full: 'Read freely. Creating/updating issues and commenting require your approval.',
  },
};
