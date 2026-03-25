import type { ServiceDefinitionWithTools } from '../common/types.js';
import { githubTools } from './tools.js';

export const definition: ServiceDefinitionWithTools = {
  type: 'github',
  name: 'GitHub',
  description: 'Repositories, issues, pull requests, and code search',
  icon: 'Github',
  category: 'dev-tools',
  toolPrefix: 'github_',
  auth: {
    type: 'api_key',
    required: true,
    instructions: 'Create a Personal Access Token at GitHub Settings > Developer Settings > Personal Access Tokens',
    keyUrl: 'https://github.com/settings/tokens',
  },
  tools: githubTools,
  permissions: {
    read: [
      'github_list_repos',
      'github_get_repo',
      'github_list_issues',
      'github_get_issue',
      'github_list_pull_requests',
      'github_get_pull_request',
      'github_get_pull_request_diff',
      'github_get_file_content',
      'github_search_code',
      'github_get_user',
    ],
    write: [
      'github_create_issue',
      'github_comment_on_issue',
    ],
    blocked: [],
  },
  permissionDescriptions: {
    read: 'List repos, read issues/PRs, view files, and search code',
    full: 'Read freely. Creating issues and commenting require your approval.',
  },
};
