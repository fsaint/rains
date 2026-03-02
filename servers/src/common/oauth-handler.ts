/**
 * Google OAuth Handler
 *
 * Manages OAuth2 flows for Google services (Gmail, Drive, Calendar)
 */

import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import pino from 'pino';
import type { GoogleOAuthConfig, OAuthTokenData } from './types.js';

const logger = pino({ name: 'oauth-handler' });

/**
 * Storage interface for OAuth tokens
 */
export interface TokenStorage {
  getTokens(credentialId: string): Promise<OAuthTokenData | null>;
  setTokens(credentialId: string, tokens: OAuthTokenData): Promise<void>;
}

/**
 * Google OAuth handler for managing authentication flows
 */
export class GoogleOAuthHandler {
  private config: GoogleOAuthConfig;
  private storage: TokenStorage;
  private clients: Map<string, OAuth2Client> = new Map();

  constructor(config: GoogleOAuthConfig, storage: TokenStorage) {
    this.config = config;
    this.storage = storage;
  }

  /**
   * Create an OAuth2 client
   */
  private createOAuth2Client(): OAuth2Client {
    return new google.auth.OAuth2(
      this.config.clientId,
      this.config.clientSecret,
      this.config.redirectUri
    );
  }

  /**
   * Generate OAuth URL for user authorization
   */
  async getAuthUrl(scopes: string[], state?: string): Promise<string> {
    const client = this.createOAuth2Client();

    const url = client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      state,
      prompt: 'consent', // Always show consent screen to get refresh token
    });

    logger.info({ scopes }, 'Generated auth URL');
    return url;
  }

  /**
   * Handle OAuth callback and exchange code for tokens
   */
  async handleCallback(
    code: string,
    credentialId: string
  ): Promise<OAuthTokenData> {
    const client = this.createOAuth2Client();

    const { tokens } = await client.getToken(code);

    if (!tokens.access_token || !tokens.refresh_token) {
      throw new Error('Failed to get tokens from OAuth callback');
    }

    const tokenData: OAuthTokenData = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expiry_date ?? Date.now() + 3600 * 1000,
      scope: tokens.scope ?? '',
    };

    await this.storage.setTokens(credentialId, tokenData);
    logger.info({ credentialId }, 'Stored OAuth tokens');

    // Cache the client with tokens
    client.setCredentials(tokens);
    this.clients.set(credentialId, client);

    return tokenData;
  }

  /**
   * Get a valid access token, refreshing if necessary
   */
  async getAccessToken(credentialId: string): Promise<string> {
    // Check if token needs refresh
    const needsRefresh = await this.needsRefresh(credentialId);
    if (needsRefresh) {
      await this.refreshToken(credentialId);
    }

    const tokens = await this.storage.getTokens(credentialId);
    if (!tokens) {
      throw new Error(`No tokens found for credential: ${credentialId}`);
    }

    return tokens.accessToken;
  }

  /**
   * Check if token needs refresh (expires within 5 minutes)
   */
  async needsRefresh(credentialId: string): Promise<boolean> {
    const tokens = await this.storage.getTokens(credentialId);
    if (!tokens) {
      return true;
    }

    const bufferMs = 5 * 60 * 1000; // 5 minutes
    return Date.now() >= tokens.expiresAt - bufferMs;
  }

  /**
   * Refresh the access token
   */
  async refreshToken(credentialId: string): Promise<OAuthTokenData> {
    const tokens = await this.storage.getTokens(credentialId);
    if (!tokens?.refreshToken) {
      throw new Error(`No refresh token for credential: ${credentialId}`);
    }

    const client = this.createOAuth2Client();
    client.setCredentials({
      refresh_token: tokens.refreshToken,
    });

    const { credentials } = await client.refreshAccessToken();

    if (!credentials.access_token) {
      throw new Error('Failed to refresh access token');
    }

    const newTokenData: OAuthTokenData = {
      accessToken: credentials.access_token,
      refreshToken: credentials.refresh_token ?? tokens.refreshToken,
      expiresAt: credentials.expiry_date ?? Date.now() + 3600 * 1000,
      scope: credentials.scope ?? tokens.scope,
    };

    await this.storage.setTokens(credentialId, newTokenData);
    logger.info({ credentialId }, 'Refreshed OAuth tokens');

    // Update cached client
    client.setCredentials(credentials);
    this.clients.set(credentialId, client);

    return newTokenData;
  }

  /**
   * Get an OAuth2 client with valid credentials
   */
  async getClient(credentialId: string): Promise<OAuth2Client> {
    // Ensure tokens are valid
    await this.getAccessToken(credentialId);

    let client = this.clients.get(credentialId);
    if (!client) {
      client = this.createOAuth2Client();
      const tokens = await this.storage.getTokens(credentialId);
      if (tokens) {
        client.setCredentials({
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          expiry_date: tokens.expiresAt,
        });
      }
      this.clients.set(credentialId, client);
    }

    return client;
  }

  /**
   * Revoke OAuth tokens
   */
  async revokeTokens(credentialId: string): Promise<void> {
    const tokens = await this.storage.getTokens(credentialId);
    if (!tokens) {
      return;
    }

    const client = this.createOAuth2Client();
    try {
      await client.revokeToken(tokens.accessToken);
      logger.info({ credentialId }, 'Revoked OAuth tokens');
    } catch (error) {
      logger.warn({ credentialId, error }, 'Failed to revoke tokens');
    }

    this.clients.delete(credentialId);
  }
}

/**
 * Scopes for Google services
 */
export const GoogleScopes = {
  Gmail: {
    READONLY: 'https://www.googleapis.com/auth/gmail.readonly',
    COMPOSE: 'https://www.googleapis.com/auth/gmail.compose',
    SEND: 'https://www.googleapis.com/auth/gmail.send',
    MODIFY: 'https://www.googleapis.com/auth/gmail.modify',
    FULL: 'https://mail.google.com/',
  },
  Drive: {
    READONLY: 'https://www.googleapis.com/auth/drive.readonly',
    FILE: 'https://www.googleapis.com/auth/drive.file',
    FULL: 'https://www.googleapis.com/auth/drive',
  },
  Calendar: {
    READONLY: 'https://www.googleapis.com/auth/calendar.readonly',
    EVENTS: 'https://www.googleapis.com/auth/calendar.events',
    FULL: 'https://www.googleapis.com/auth/calendar',
  },
} as const;
