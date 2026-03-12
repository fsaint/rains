/**
 * Service Registry
 *
 * Central registry of all available service definitions.
 * To add a new service, create its definition and add it to the array below.
 */

import type { ServiceDefinition } from './common/types.js';
import type { ToolDefinition } from './common/base-server.js';
import { gmailTools } from './gmail/tools.js';
import { driveTools } from './drive/tools.js';
import { calendarTools } from './calendar/tools.js';
import { webSearchTools } from './web-search/tools.js';
import { browserTools } from './browser/tools.js';
import { githubTools } from './github/tools.js';

// ============================================================================
// Helper
// ============================================================================

export interface ServiceDefinitionWithTools extends ServiceDefinition {
  tools: ToolDefinition[];
}

function buildDefaultPermissions(
  permissions: ServiceDefinition['permissions']
): Record<string, 'allow' | 'require_approval' | 'block'> {
  const result: Record<string, 'allow' | 'require_approval' | 'block'> = {};
  for (const tool of permissions.read) result[tool] = 'allow';
  for (const tool of permissions.write) result[tool] = 'require_approval';
  for (const tool of permissions.blocked) result[tool] = 'block';
  return result;
}

// ============================================================================
// Service Definitions
// ============================================================================

const gmailService: ServiceDefinitionWithTools = {
  type: 'gmail',
  name: 'Gmail',
  description: 'Read, search, and draft emails',
  icon: 'Mail',
  category: 'google',
  toolPrefix: 'gmail_',
  auth: {
    type: 'oauth2',
    required: true,
    credentialServiceIds: ['gmail', 'google'],
    oauthScopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ],
  },
  tools: gmailTools,
  permissions: {
    read: ['gmail_list_accounts', 'gmail_list_messages', 'gmail_get_message', 'gmail_search', 'gmail_list_labels'],
    write: ['gmail_create_draft', 'gmail_send_draft'],
    blocked: ['gmail_send_message', 'gmail_delete_message'],
  },
  permissionDescriptions: {
    read: 'List, read, and search emails',
    full: 'Read emails freely. Creating drafts and sending require your approval.',
  },
};

const driveService: ServiceDefinitionWithTools = {
  type: 'drive',
  name: 'Google Drive',
  description: 'List, read, and search files',
  icon: 'HardDrive',
  category: 'google',
  toolPrefix: 'drive_',
  auth: {
    type: 'oauth2',
    required: true,
    credentialServiceIds: ['drive', 'google'],
    oauthScopes: [
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  },
  tools: driveTools,
  permissions: {
    read: ['drive_list_files', 'drive_get_file', 'drive_read_file', 'drive_search'],
    write: ['drive_create_file', 'drive_update_file'],
    blocked: ['drive_share_file', 'drive_delete_file'],
  },
  permissionDescriptions: {
    read: 'List, read, and search files',
    full: 'Read files freely. Creating and updating files require your approval.',
  },
};

const calendarService: ServiceDefinitionWithTools = {
  type: 'calendar',
  name: 'Google Calendar',
  description: 'View and manage calendar events',
  icon: 'Calendar',
  category: 'google',
  toolPrefix: 'calendar_',
  auth: {
    type: 'oauth2',
    required: true,
    credentialServiceIds: ['calendar', 'google'],
    oauthScopes: [
      'https://www.googleapis.com/auth/calendar.readonly',
    ],
  },
  tools: calendarTools,
  permissions: {
    read: ['calendar_list_events', 'calendar_get_event', 'calendar_search_events', 'calendar_list_calendars'],
    write: ['calendar_create_event', 'calendar_update_event'],
    blocked: ['calendar_delete_event'],
  },
  permissionDescriptions: {
    read: 'List, view, and search events',
    full: 'View events freely. Creating and updating events require your approval.',
  },
};

const webSearchService: ServiceDefinitionWithTools = {
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

const browserService: ServiceDefinitionWithTools = {
  type: 'browser',
  name: 'Browser',
  description: 'Headless browser automation via Playwright',
  icon: 'Globe',
  category: 'browser',
  toolPrefix: 'browser_',
  auth: {
    type: 'none',
    required: false,
  },
  tools: browserTools,
  permissions: {
    read: ['browser_navigate', 'browser_screenshot', 'browser_get_content', 'browser_close'],
    write: ['browser_click', 'browser_type'],
    blocked: ['browser_evaluate'],
  },
  permissionDescriptions: {
    read: 'Navigate pages and take screenshots',
    full: 'Navigate freely. Clicking and typing require your approval.',
  },
};

// ============================================================================
// Registry
// ============================================================================

const githubService: ServiceDefinitionWithTools = {
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

export const serviceDefinitions: ServiceDefinitionWithTools[] = [
  gmailService,
  driveService,
  calendarService,
  webSearchService,
  browserService,
  githubService,
];

/** Lookup map by service type */
export const serviceRegistry = new Map<string, ServiceDefinitionWithTools>(
  serviceDefinitions.map((def) => [def.type, def])
);

/** Resolve a tool name to its service type via prefix matching */
export function getServiceTypeFromToolName(toolName: string): string | null {
  for (const def of serviceDefinitions) {
    if (toolName.startsWith(def.toolPrefix)) return def.type;
  }
  return null;
}

/** Build default permission map for a service (read→allow, write→require_approval, blocked→block) */
export function getDefaultPermissions(serviceType: string): Record<string, 'allow' | 'require_approval' | 'block'> {
  const def = serviceRegistry.get(serviceType);
  if (!def) return {};
  return buildDefaultPermissions(def.permissions);
}
