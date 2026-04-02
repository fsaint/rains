import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { client } from '../db/index.js';
import { nanoid } from 'nanoid';
import type { CredentialType, CredentialData, CredentialHealth } from '@reins/shared';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT = 'reins-credential-vault'; // In production, use unique salt per credential

interface EncryptedCredential {
  encryptedData: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export class CredentialVault {
  private key: Buffer;

  constructor(encryptionKey?: string) {
    if (encryptionKey) {
      // Key provided as hex string
      this.key = Buffer.from(encryptionKey, 'hex');
    } else {
      // Derive key from a default passphrase (for development only!)
      console.warn('No encryption key provided. Using development key. DO NOT use in production!');
      this.key = scryptSync('reins-dev-key', SALT, KEY_LENGTH);
    }

    if (this.key.length !== KEY_LENGTH) {
      throw new Error(`Encryption key must be ${KEY_LENGTH} bytes (${KEY_LENGTH * 2} hex chars)`);
    }
  }

  /**
   * Encrypt credential data
   */
  private encrypt(data: CredentialData): EncryptedCredential {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);

    const plaintext = JSON.stringify(data);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    return {
      encryptedData: encrypted,
      iv,
      authTag,
    };
  }

  /**
   * Decrypt credential data
   */
  private decrypt(encrypted: EncryptedCredential): CredentialData {
    const decipher = createDecipheriv(ALGORITHM, this.key, encrypted.iv);
    decipher.setAuthTag(encrypted.authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted.encryptedData),
      decipher.final(),
    ]);

    return JSON.parse(decrypted.toString('utf8'));
  }

  /**
   * Store a credential
   */
  async store(
    serviceId: string,
    type: CredentialType,
    data: CredentialData
  ): Promise<string> {
    const id = nanoid();
    const encrypted = this.encrypt(data);

    // Calculate expiration for OAuth tokens
    let expiresAt: string | undefined;
    if ('expiresAt' in data && data.expiresAt) {
      expiresAt = data.expiresAt.toISOString();
    }

    await client.execute({
      sql: `INSERT INTO credentials (id, service_id, type, encrypted_data, iv, auth_tag, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        serviceId,
        type,
        encrypted.encryptedData.toString('base64'),
        encrypted.iv.toString('base64'),
        encrypted.authTag.toString('base64'),
        expiresAt ?? null,
      ],
    });

    return id;
  }

  /**
   * Store an OAuth credential with account information
   */
  async storeOAuth(options: {
    serviceId: string;
    accountEmail: string;
    accountName?: string;
    userId?: string;
    grantedServices?: string[];
    data: CredentialData;
  }): Promise<string> {
    const id = nanoid();
    const encrypted = this.encrypt(options.data);

    // Calculate expiration for OAuth tokens
    let expiresAt: string | undefined;
    if ('expiresAt' in options.data && options.data.expiresAt) {
      expiresAt = options.data.expiresAt.toISOString();
    }

    await client.execute({
      sql: `INSERT INTO credentials (id, user_id, service_id, type, encrypted_data, iv, auth_tag, expires_at, account_email, account_name, granted_services) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        options.userId ?? null,
        options.serviceId,
        'oauth2',
        encrypted.encryptedData.toString('base64'),
        encrypted.iv.toString('base64'),
        encrypted.authTag.toString('base64'),
        expiresAt ?? null,
        options.accountEmail,
        options.accountName ?? null,
        options.grantedServices ? JSON.stringify(options.grantedServices) : null,
      ],
    });

    return id;
  }

  /**
   * Retrieve a credential
   */
  async retrieve(credentialId: string): Promise<{
    serviceId: string;
    type: CredentialType;
    data: CredentialData;
    accountEmail?: string;
    accountName?: string;
  } | null> {
    const result = await client.execute({
      sql: `SELECT * FROM credentials WHERE id = ?`,
      args: [credentialId],
    });

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    const data = this.decrypt({
      encryptedData: Buffer.from(row.encrypted_data as string, 'base64'),
      iv: Buffer.from(row.iv as string, 'base64'),
      authTag: Buffer.from(row.auth_tag as string, 'base64'),
    });

    return {
      serviceId: row.service_id as string,
      type: row.type as CredentialType,
      data,
      accountEmail: row.account_email as string | undefined,
      accountName: row.account_name as string | undefined,
    };
  }

  /**
   * Retrieve credential by service ID
   */
  async retrieveByService(serviceId: string): Promise<{ id: string; type: CredentialType; data: CredentialData } | null> {
    const result = await client.execute({
      sql: `SELECT * FROM credentials WHERE service_id = ? LIMIT 1`,
      args: [serviceId],
    });

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    const data = this.decrypt({
      encryptedData: Buffer.from(row.encrypted_data as string, 'base64'),
      iv: Buffer.from(row.iv as string, 'base64'),
      authTag: Buffer.from(row.auth_tag as string, 'base64'),
    });

    return {
      id: row.id as string,
      type: row.type as CredentialType,
      data,
    };
  }

  /**
   * Delete a credential
   */
  async delete(credentialId: string): Promise<boolean> {
    const result = await client.execute({
      sql: `DELETE FROM credentials WHERE id = ?`,
      args: [credentialId],
    });

    return result.rowsAffected > 0;
  }

  /**
   * List all credentials (metadata only, no decryption)
   */
  async list(userId?: string): Promise<Array<{
    id: string;
    serviceId: string;
    type: CredentialType;
    accountEmail?: string;
    accountName?: string;
    grantedServices?: string[];
    expiresAt?: Date;
    createdAt: Date;
  }>> {
    const result = userId
      ? await client.execute({
          sql: `SELECT id, service_id, type, account_email, account_name, granted_services, expires_at, created_at FROM credentials WHERE user_id = ?`,
          args: [userId],
        })
      : await client.execute(`SELECT id, service_id, type, account_email, account_name, granted_services, expires_at, created_at FROM credentials`);

    return result.rows.map((row) => ({
      id: row.id as string,
      serviceId: row.service_id as string,
      type: row.type as CredentialType,
      accountEmail: row.account_email as string | undefined,
      accountName: row.account_name as string | undefined,
      grantedServices: row.granted_services ? JSON.parse(row.granted_services as string) : undefined,
      expiresAt: row.expires_at ? new Date(row.expires_at as string) : undefined,
      createdAt: new Date(row.created_at as string),
    }));
  }

  /**
   * Check credential health, attempting a token refresh if expired.
   */
  async checkHealth(credentialId: string): Promise<CredentialHealth> {
    let credential: Awaited<ReturnType<typeof this.retrieve>>;
    try {
      credential = await this.retrieve(credentialId);
    } catch {
      return {
        credentialId,
        serviceId: 'unknown',
        valid: false,
        lastChecked: new Date(),
        error: 'Credential data is corrupted — please re-authorize',
      };
    }

    if (!credential) {
      return {
        credentialId,
        serviceId: 'unknown',
        valid: false,
        lastChecked: new Date(),
        error: 'Credential not found',
      };
    }

    // Check expiration for OAuth tokens
    let expiresAt: Date | undefined;
    if ('expiresAt' in credential.data && credential.data.expiresAt) {
      expiresAt = new Date(credential.data.expiresAt);
    }

    const now = new Date();
    let valid = !expiresAt || expiresAt > now;

    // If expired, try refreshing the token
    if (!valid) {
      const refreshed = await this.getValidAccessToken(credentialId);
      if (refreshed) {
        // Re-read the updated credential to get the new expiresAt
        const updated = await this.retrieve(credentialId);
        if (updated && 'expiresAt' in updated.data && updated.data.expiresAt) {
          expiresAt = new Date(updated.data.expiresAt);
        }
        valid = true;
      }
    }

    return {
      credentialId,
      serviceId: credential.serviceId,
      valid,
      expiresAt,
      lastChecked: now,
      error: valid ? undefined : 'Credential expired and refresh failed',
    };
  }

  /**
   * Update credential data (for token refresh)
   */
  async update(credentialId: string, data: CredentialData): Promise<boolean> {
    const encrypted = this.encrypt(data);

    let expiresAt: string | undefined;
    if ('expiresAt' in data && data.expiresAt) {
      expiresAt = data.expiresAt.toISOString();
    }

    const result = await client.execute({
      sql: `UPDATE credentials SET encrypted_data = ?, iv = ?, auth_tag = ?, expires_at = ?, updated_at = ? WHERE id = ?`,
      args: [
        encrypted.encryptedData.toString('base64'),
        encrypted.iv.toString('base64'),
        encrypted.authTag.toString('base64'),
        expiresAt ?? null,
        new Date().toISOString(),
        credentialId,
      ],
    });

    return result.rowsAffected > 0;
  }

  /**
   * Get a valid access token for a Google OAuth credential, refreshing if expired.
   * Returns the access token string or null if refresh fails.
   */
  async getValidAccessToken(credentialId: string): Promise<string | null> {
    const credential = await this.retrieve(credentialId);
    if (!credential) return null;

    const data = credential.data as {
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: string | Date;
      tokenType?: string;
    };

    if (!data.accessToken) return null;

    // No expiration means token never expires (e.g. GitHub PATs, API keys)
    if (!data.expiresAt) {
      return data.accessToken;
    }

    // Check if token is still valid (with 5-minute buffer)
    const expiresAt = new Date(data.expiresAt);
    const bufferMs = 5 * 60 * 1000;
    if (expiresAt.getTime() - bufferMs > Date.now()) {
      return data.accessToken;
    }

    // Token expired — refresh it
    if (!data.refreshToken) {
      console.warn(`Credential ${credentialId} expired and has no refresh token`);
      return null;
    }

    const { config } = await import('../config/index.js');

    // Determine refresh endpoint and params based on service
    let tokenUrl: string;
    let refreshParams: Record<string, string>;

    if (credential.serviceId === 'microsoft') {
      // Microsoft OAuth2 token refresh
      if (!config.microsoftClientId || !config.microsoftClientSecret) {
        console.error('Cannot refresh token: Microsoft OAuth not configured');
        return null;
      }
      const tenantId = config.microsoftTenantId || 'common';
      tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
      refreshParams = {
        client_id: config.microsoftClientId,
        client_secret: config.microsoftClientSecret,
        refresh_token: data.refreshToken,
        grant_type: 'refresh_token',
      };
    } else {
      // Google OAuth2 token refresh (default)
      if (!config.googleClientId || !config.googleClientSecret) {
        console.error('Cannot refresh token: Google OAuth not configured');
        return null;
      }
      tokenUrl = 'https://oauth2.googleapis.com/token';
      refreshParams = {
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        refresh_token: data.refreshToken,
        grant_type: 'refresh_token',
      };
    }

    try {
      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(refreshParams),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        console.error('Token refresh failed:', err);
        return null;
      }

      const tokens = await response.json() as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
        token_type: string;
      };

      // Update stored credential with new access token
      // Microsoft may return a new refresh token — always save it
      const newData: CredentialData = {
        ...data,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || data.refreshToken,
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        tokenType: tokens.token_type,
      } as CredentialData;

      await this.update(credentialId, newData);

      return tokens.access_token;
    } catch (error) {
      console.error('Token refresh error:', error);
      return null;
    }
  }

  /**
   * Proactively refresh all OAuth credentials that are expired or expiring soon.
   * Runs as a background task to keep tokens fresh.
   */
  async refreshAllExpiring(): Promise<{ refreshed: number; failed: number }> {
    const bufferMs = 10 * 60 * 1000; // 10 minutes before expiry
    const threshold = new Date(Date.now() + bufferMs).toISOString();

    const result = await client.execute({
      sql: `SELECT id FROM credentials WHERE type = 'oauth2' AND expires_at IS NOT NULL AND expires_at < ?`,
      args: [threshold],
    });

    let refreshed = 0;
    let failed = 0;

    for (const row of result.rows) {
      const id = row.id as string;
      const token = await this.getValidAccessToken(id);
      if (token) {
        refreshed++;
      } else {
        failed++;
      }
    }

    return { refreshed, failed };
  }
}

export const credentialVault = new CredentialVault(process.env.REINS_ENCRYPTION_KEY);

let refreshInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start background token refresh loop.
 * Refreshes tokens every 45 minutes (Google access tokens last 1 hour).
 */
export function startTokenRefreshLoop() {
  const INTERVAL_MS = 45 * 60 * 1000; // 45 minutes

  // Run once immediately
  credentialVault.refreshAllExpiring().then(({ refreshed, failed }) => {
    if (refreshed > 0 || failed > 0) {
      console.log(`Token refresh: ${refreshed} refreshed, ${failed} failed`);
    }
  }).catch((err) => {
    console.error('Token refresh error:', err);
  });

  refreshInterval = setInterval(async () => {
    try {
      const { refreshed, failed } = await credentialVault.refreshAllExpiring();
      if (refreshed > 0 || failed > 0) {
        console.log(`Token refresh: ${refreshed} refreshed, ${failed} failed`);
      }
    } catch (err) {
      console.error('Token refresh error:', err);
    }
  }, INTERVAL_MS);
}

export function stopTokenRefreshLoop() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}
