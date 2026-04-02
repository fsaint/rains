/**
 * Reins Native MCP Servers
 *
 * This package provides native MCP servers for:
 * - Gmail (Google Mail API)
 * - Drive (Google Drive API)
 * - Calendar (Google Calendar API)
 * - Web Search (Brave Search API)
 * - Browser (Playwright headless browser)
 * - GitHub (GitHub REST API)
 */

export { GmailServer, gmailTools } from './gmail/index.js';
export { DriveServer, driveTools } from './drive/index.js';
export { CalendarServer, calendarTools } from './calendar/index.js';
export { WebSearchServer, webSearchTools } from './web-search/index.js';
export { BrowserServer, browserTools } from './browser/index.js';
export { GitHubServer, githubTools, validateToken as validateGitHubToken, TOOL_REQUIRED_SCOPES as GITHUB_TOOL_SCOPES } from './github/index.js';
export { LinearServer, linearTools } from './linear/index.js';
export { OutlookMailServer, outlookMailTools, validateToken as validateOutlookToken } from './outlook-mail/index.js';
export { OutlookCalendarServer, outlookCalendarTools } from './outlook-calendar/index.js';
export { NotionServer, notionTools, validateToken as validateNotionToken } from './notion/index.js';

export { BaseServer } from './common/base-server.js';
export { GoogleOAuthHandler } from './common/oauth-handler.js';
export { CredentialBridge } from './common/credential-bridge.js';

export type { ServerConfig, ServerContext, ServiceDefinition, ServiceDefinitionWithTools } from './common/types.js';
export type { ToolDefinition } from './common/base-server.js';

// Service Registry
export {
  serviceDefinitions,
  serviceRegistry,
  getServiceTypeFromToolName,
  getDefaultPermissions,
} from './registry.js';
