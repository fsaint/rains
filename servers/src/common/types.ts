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
  category: 'google' | 'productivity' | 'dev-tools' | 'communication' | 'search' | 'browser';
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
