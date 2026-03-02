/**
 * Common utilities for MCP servers
 */

export { BaseServer, type ToolDefinition, type ToolHandler } from './base-server.js';
export {
  GoogleOAuthHandler,
  GoogleScopes,
  type TokenStorage,
} from './oauth-handler.js';
export {
  CredentialBridge,
  InMemoryVaultClient,
  type CredentialVaultClient,
  type CredentialData,
  type StoreCredentialRequest,
} from './credential-bridge.js';
export type {
  ServerConfig,
  ServerContext,
  ToolResult,
  GoogleOAuthConfig,
  OAuthTokenData,
  BraveSearchConfig,
  BrowserConfig,
  BrowserSession,
} from './types.js';
