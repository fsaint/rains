/**
 * Common types for MCP servers
 */

import type { Credential } from '@reins/shared';

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
