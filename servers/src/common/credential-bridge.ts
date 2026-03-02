/**
 * Credential Bridge
 *
 * Connects MCP servers to the Reins credential vault
 */

import pino from 'pino';
import type { OAuthTokenData } from './types.js';
import type { TokenStorage } from './oauth-handler.js';

const logger = pino({ name: 'credential-bridge' });

/**
 * Interface for credential vault operations
 * This matches the backend CredentialVault API
 */
export interface CredentialVaultClient {
  retrieve(id: string): Promise<CredentialData | null>;
  store(credential: StoreCredentialRequest): Promise<string>;
  update(id: string, data: Partial<CredentialData>): Promise<void>;
  delete(id: string): Promise<void>;
  listByService(service: string): Promise<CredentialData[]>;
}

export interface CredentialData {
  id: string;
  service: string;
  name: string;
  type: 'oauth2' | 'api_key' | 'basic';
  data: Record<string, unknown>;
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface StoreCredentialRequest {
  service: string;
  name: string;
  type: 'oauth2' | 'api_key' | 'basic';
  data: Record<string, unknown>;
  expiresAt?: number;
}

/**
 * Bridge between MCP servers and the credential vault
 * Implements TokenStorage interface for OAuth handler
 */
export class CredentialBridge implements TokenStorage {
  private vault: CredentialVaultClient;
  private tokenCache: Map<string, { tokens: OAuthTokenData; cachedAt: number }> =
    new Map();
  private readonly cacheMaxAge = 60 * 1000; // 1 minute cache

  constructor(vault: CredentialVaultClient) {
    this.vault = vault;
  }

  /**
   * Get OAuth tokens for a credential
   * Implements TokenStorage interface
   */
  async getTokens(credentialId: string): Promise<OAuthTokenData | null> {
    // Check cache first
    const cached = this.tokenCache.get(credentialId);
    if (cached && Date.now() - cached.cachedAt < this.cacheMaxAge) {
      return cached.tokens;
    }

    const credential = await this.vault.retrieve(credentialId);
    if (!credential || credential.type !== 'oauth2') {
      return null;
    }

    const data = credential.data as unknown as OAuthTokenData;
    if (!data.accessToken || !data.refreshToken) {
      return null;
    }

    // Cache the tokens
    this.tokenCache.set(credentialId, {
      tokens: data,
      cachedAt: Date.now(),
    });

    return data;
  }

  /**
   * Store OAuth tokens for a credential
   * Implements TokenStorage interface
   */
  async setTokens(credentialId: string, tokens: OAuthTokenData): Promise<void> {
    await this.vault.update(credentialId, {
      data: tokens as unknown as Record<string, unknown>,
      expiresAt: tokens.expiresAt,
    });

    // Update cache
    this.tokenCache.set(credentialId, {
      tokens,
      cachedAt: Date.now(),
    });

    logger.debug({ credentialId }, 'Updated OAuth tokens in vault');
  }

  /**
   * Get API key for a service
   */
  async getApiKey(credentialId: string): Promise<string | null> {
    const credential = await this.vault.retrieve(credentialId);
    if (!credential || credential.type !== 'api_key') {
      return null;
    }

    return (credential.data as { apiKey?: string }).apiKey ?? null;
  }

  /**
   * Store a new API key credential
   */
  async storeApiKey(
    service: string,
    name: string,
    apiKey: string
  ): Promise<string> {
    return this.vault.store({
      service,
      name,
      type: 'api_key',
      data: { apiKey },
    });
  }

  /**
   * Create a new OAuth credential (before tokens are obtained)
   */
  async createOAuthCredential(
    service: string,
    name: string
  ): Promise<string> {
    return this.vault.store({
      service,
      name,
      type: 'oauth2',
      data: {},
    });
  }

  /**
   * Get credential by service name
   */
  async getCredentialByService(service: string): Promise<CredentialData | null> {
    const credentials = await this.vault.listByService(service);
    return credentials[0] ?? null;
  }

  /**
   * Delete a credential
   */
  async deleteCredential(credentialId: string): Promise<void> {
    await this.vault.delete(credentialId);
    this.tokenCache.delete(credentialId);
    logger.info({ credentialId }, 'Deleted credential');
  }

  /**
   * Clear token cache for a credential
   */
  invalidateCache(credentialId: string): void {
    this.tokenCache.delete(credentialId);
  }

  /**
   * Clear all cached tokens
   */
  clearCache(): void {
    this.tokenCache.clear();
  }
}

/**
 * In-memory vault client for testing
 */
export class InMemoryVaultClient implements CredentialVaultClient {
  private credentials: Map<string, CredentialData> = new Map();
  private idCounter = 0;

  async retrieve(id: string): Promise<CredentialData | null> {
    return this.credentials.get(id) ?? null;
  }

  async store(request: StoreCredentialRequest): Promise<string> {
    const id = `cred_${++this.idCounter}`;
    const now = Date.now();
    this.credentials.set(id, {
      id,
      ...request,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async update(id: string, data: Partial<CredentialData>): Promise<void> {
    const existing = this.credentials.get(id);
    if (!existing) {
      throw new Error(`Credential not found: ${id}`);
    }
    this.credentials.set(id, {
      ...existing,
      ...data,
      updatedAt: Date.now(),
    });
  }

  async delete(id: string): Promise<void> {
    this.credentials.delete(id);
  }

  async listByService(service: string): Promise<CredentialData[]> {
    return Array.from(this.credentials.values()).filter(
      (c) => c.service === service
    );
  }
}
