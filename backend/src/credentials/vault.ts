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
        encrypted.encryptedData,
        encrypted.iv,
        encrypted.authTag,
        expiresAt ?? null,
      ],
    });

    return id;
  }

  /**
   * Retrieve a credential
   */
  async retrieve(credentialId: string): Promise<{ serviceId: string; type: CredentialType; data: CredentialData } | null> {
    const result = await client.execute({
      sql: `SELECT * FROM credentials WHERE id = ?`,
      args: [credentialId],
    });

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    const data = this.decrypt({
      encryptedData: Buffer.from(row.encrypted_data as ArrayBuffer),
      iv: Buffer.from(row.iv as ArrayBuffer),
      authTag: Buffer.from(row.auth_tag as ArrayBuffer),
    });

    return {
      serviceId: row.service_id as string,
      type: row.type as CredentialType,
      data,
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
      encryptedData: Buffer.from(row.encrypted_data as ArrayBuffer),
      iv: Buffer.from(row.iv as ArrayBuffer),
      authTag: Buffer.from(row.auth_tag as ArrayBuffer),
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
  async list(): Promise<Array<{
    id: string;
    serviceId: string;
    type: CredentialType;
    expiresAt?: Date;
    createdAt: Date;
  }>> {
    const result = await client.execute(`SELECT id, service_id, type, expires_at, created_at FROM credentials`);

    return result.rows.map((row) => ({
      id: row.id as string,
      serviceId: row.service_id as string,
      type: row.type as CredentialType,
      expiresAt: row.expires_at ? new Date(row.expires_at as string) : undefined,
      createdAt: new Date(row.created_at as string),
    }));
  }

  /**
   * Check credential health
   */
  async checkHealth(credentialId: string): Promise<CredentialHealth> {
    const credential = await this.retrieve(credentialId);

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
    const valid = !expiresAt || expiresAt > now;

    return {
      credentialId,
      serviceId: credential.serviceId,
      valid,
      expiresAt,
      lastChecked: now,
      error: valid ? undefined : 'Credential expired',
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
        encrypted.encryptedData,
        encrypted.iv,
        encrypted.authTag,
        expiresAt ?? null,
        new Date().toISOString(),
        credentialId,
      ],
    });

    return result.rowsAffected > 0;
  }
}

export const credentialVault = new CredentialVault(process.env.REINS_ENCRYPTION_KEY);
