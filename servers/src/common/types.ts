/**
 * Common types for MCP servers
 */

import type { Credential } from '@reins/shared';
import type { ToolDefinition } from './base-server.js';

/**
 * Configuration for initializing a server
 */
export interface ServerConfig {
  /** Unique identifier for this server instance */
  serverId: string;
  /** Human-readable name */
  name: string;
  /** Credential ID for authentication */
  credentialId?: string;
  /** Whether to enable debug logging */
  debug?: boolean;
}

/**
 * A path-based permission rule for Google Drive.
 *
 * Names a folder by its Drive folder ID and grants a permission level to that
 * folder and everything beneath it. A file's effective level is found by
 * walking its `parents` upward to the nearest rule folder; with no rule on
 * the way to the root, `ServerContext.driveDefaultLevel` applies. A file with
 * several parents is blocked if any chain is blocked, otherwise gets the
 * highest granted level. A shared drive's id names its root folder, so a rule
 * on it scopes the whole drive. See servers/src/drive/path-rules.ts.
 */
export interface DrivePathRule {
  /** Google Drive folder ID (e.g. "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs"), or a shared drive ID */
  folderId: string;
  /** Human-readable label (e.g. "/my_agent_folder") */
  label?: string;
  /** Permission level for this folder and all of its descendants */
  permission: 'read' | 'write' | 'blocked';
}

/**
 * Context passed to tool handlers
 */
export interface ServerContext {
  /** The credential for this request */
  credential?: Credential;
  /** Access token for API calls */
  accessToken?: string;
  /** Agent ID making the request */
  agentId?: string;
  /** Request ID for tracing */
  requestId: string;
  /** Linked accounts for multi-account support */
  linkedAccounts?: Array<{ email: string; name?: string; isDefault: boolean }>;
  /**
   * Default Drive permission level (for Drive service only): what applies to
   * any file with no DrivePathRule on its ancestry. Absent means 'write'.
   */
  driveDefaultLevel?: 'read' | 'write' | 'blocked';
  /** Per-folder Drive path rules (for Drive service only); each covers its folder's descendants */
  drivePathRules?: DrivePathRule[];
  /** Gateway token for services that call back into the Reins API (e.g. memory) */
  gatewayToken?: string;
  /**
   * Per-instance settings chosen when the service was added to the agent
   * (e.g. Hermeneutix `{ projectId, projectName }`). Absent when the instance
   * has no settings. Must be forwarded by the init-servers whitelist.
   */
  instanceConfig?: Record<string, unknown>;
}

/**
 * Result of a tool execution
 */
export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Google OAuth configuration
 */
export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Token data stored in credentials
 */
export interface OAuthTokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}

/**
 * Brave Search API configuration
 */
export interface BraveSearchConfig {
  apiKey: string;
}

/**
 * Browser session configuration
 */
export interface BrowserConfig {
  /** Maximum concurrent browser instances */
  maxInstances?: number;
  /** Idle timeout in milliseconds before closing session */
  idleTimeout?: number;
  /** Allowed domains for navigation (glob patterns) */
  allowedDomains?: string[];
  /** Blocked domains (glob patterns) */
  blockedDomains?: string[];
}

/**
 * Browser session state
 */
export interface BrowserSession {
  id: string;
  createdAt: number;
  lastActivity: number;
  currentUrl?: string;
}

/**
 * Service definition — the single source of truth for a service's metadata,
 * tools, auth requirements, and permission classifications.
 */
export interface ServiceDefinition {
  /** Unique service type key, e.g. 'gmail', 'github' */
  type: string;
  /** Human-readable display name */
  name: string;
  /** Short description of the service */
  description: string;
  /** Lucide icon name, e.g. 'Mail', 'HardDrive', 'Github' */
  icon: string;
  /** Category for grouping in the UI */
  category: 'google' | 'microsoft' | 'productivity' | 'dev-tools' | 'communication' | 'search' | 'browser';
  /** Prefix used to match tool names to this service */
  toolPrefix: string;
  /** Auth requirements */
  auth: {
    type: 'oauth2' | 'api_key' | 'none';
    /** Whether credentials are required to call tools */
    required: boolean;
    /** Credential service IDs to match (e.g. ['gmail', 'google']) */
    credentialServiceIds?: string[];
    /** OAuth scopes required for this service */
    oauthScopes?: string[];
    /** Instructions for obtaining an API key */
    instructions?: string;
    /** URL where the user can get an API key */
    keyUrl?: string;
  };
  /** Permission classification of tools */
  permissions: {
    read: string[];
    write: string[];
    blocked: string[];
    /** Default permission for write tools. Services with no external API risk can set this to 'allow'. Defaults to 'require_approval'. */
    defaultWritePermission?: 'allow' | 'require_approval';
  };
  /** Human-readable descriptions for permission levels */
  permissionDescriptions: {
    read: string;
    full: string;
  };
}

/**
 * Service definition with its tool definitions included.
 * Each server co-locates this in its own `definition.ts`.
 */
export interface ServiceDefinitionWithTools extends ServiceDefinition {
  tools: ToolDefinition[];
}
