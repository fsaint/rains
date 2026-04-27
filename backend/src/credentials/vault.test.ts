/**
 * Credential Vault Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'crypto';

vi.mock('../db/index.js', () => ({
  client: {
    execute: vi.fn().mockResolvedValue({ rows: [], rowsAffected: 0, lastInsertRowid: 0n }),
  },
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'test-cred-id'),
}));

import { client } from '../db/index.js';
import { CredentialVault } from './vault.js';

// Generate a valid 32-byte hex key for tests
const TEST_KEY = randomBytes(32).toString('hex');

describe('CredentialVault', () => {
  let vault: CredentialVault;

  beforeEach(() => {
    vi.clearAllMocks();
    vault = new CredentialVault(TEST_KEY);
  });

  // ==========================================================================
  // Constructor
  // ==========================================================================

  describe('constructor', () => {
    it('should accept a valid 64-char hex key', () => {
      expect(() => new CredentialVault(TEST_KEY)).not.toThrow();
    });

    it('should throw for invalid key length', () => {
      expect(() => new CredentialVault('short')).toThrow('Encryption key must be 32 bytes');
    });

    it('should use a dev key when no key provided', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const devVault = new CredentialVault();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('development key'));
      warnSpy.mockRestore();
    });
  });

  // ==========================================================================
  // Encryption round-trip
  // ==========================================================================

  describe('encrypt/decrypt (via store + retrieve)', () => {
    it('should encrypt and decrypt API key credential', async () => {
      const credData = { apiKey: 'sk-test-12345' };

      // Capture encrypted data on store
      let storedArgs: unknown[] = [];
      vi.mocked(client.execute).mockImplementationOnce(async (input) => {
        storedArgs = (input as { args: unknown[] }).args;
        return { rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] };
      });

      await vault.store('brave-search', 'api_key', credData);

      // Verify encrypted data is base64 strings (not raw buffers)
      const encryptedData = storedArgs[3] as string;
      const iv = storedArgs[4] as string;
      const authTag = storedArgs[5] as string;

      expect(typeof encryptedData).toBe('string');
      expect(typeof iv).toBe('string');
      expect(typeof authTag).toBe('string');
      // Should be valid base64
      expect(() => Buffer.from(encryptedData, 'base64')).not.toThrow();
      expect(() => Buffer.from(iv, 'base64')).not.toThrow();

      // Now simulate retrieval
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [{
          id: 'test-cred-id',
          service_id: 'brave-search',
          type: 'api_key',
          encrypted_data: encryptedData,
          iv,
          auth_tag: authTag,
          expires_at: null,
          account_email: null,
          account_name: null,
        }],
        rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const result = await vault.retrieve('test-cred-id');
      expect(result).not.toBeNull();
      expect(result!.data).toEqual(credData);
      expect(result!.serviceId).toBe('brave-search');
      expect(result!.type).toBe('api_key');
    });

    it('should encrypt and decrypt OAuth credential', async () => {
      const credData = {
        accessToken: 'ya29.test-token',
        refreshToken: '1//test-refresh',
        tokenType: 'Bearer',
        expiresAt: new Date('2024-12-31T00:00:00Z'),
      };

      let storedArgs: unknown[] = [];
      vi.mocked(client.execute).mockImplementationOnce(async (input) => {
        storedArgs = (input as { args: unknown[] }).args;
        return { rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] };
      });

      await vault.store('google-gmail', 'oauth2', credData);

      // Retrieve
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [{
          id: 'test-cred-id', service_id: 'google-gmail', type: 'oauth2',
          encrypted_data: storedArgs[3], iv: storedArgs[4], auth_tag: storedArgs[5],
          expires_at: '2024-12-31T00:00:00.000Z', account_email: null, account_name: null,
        }],
        rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const result = await vault.retrieve('test-cred-id');
      expect(result).not.toBeNull();
      expect((result!.data as any).accessToken).toBe('ya29.test-token');
      expect((result!.data as any).refreshToken).toBe('1//test-refresh');
    });

    it('should fail decryption with wrong key', async () => {
      let storedArgs: unknown[] = [];
      vi.mocked(client.execute).mockImplementationOnce(async (input) => {
        storedArgs = (input as { args: unknown[] }).args;
        return { rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] };
      });

      await vault.store('test', 'api_key', { apiKey: 'secret' });

      // Try to decrypt with a different key
      const otherKey = randomBytes(32).toString('hex');
      const otherVault = new CredentialVault(otherKey);

      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [{
          id: 'test-cred-id', service_id: 'test', type: 'api_key',
          encrypted_data: storedArgs[3], iv: storedArgs[4], auth_tag: storedArgs[5],
          expires_at: null, account_email: null, account_name: null,
        }],
        rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      await expect(otherVault.retrieve('test-cred-id')).rejects.toThrow();
    });
  });

  // ==========================================================================
  // storeOAuth
  // ==========================================================================

  describe('storeOAuth', () => {
    it('should store OAuth credential with account info', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [],
      });

      const id = await vault.storeOAuth({
        serviceId: 'google-gmail',
        accountEmail: 'user@gmail.com',
        accountName: 'Test User',
        userId: 'user-123',
        grantedServices: ['gmail', 'drive'],
        data: { accessToken: 'token', tokenType: 'Bearer' },
      });

      expect(id).toBe('test-cred-id');
      const call = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
      expect(call.sql).toContain('account_email');
      expect(call.args).toContain('user@gmail.com');
      expect(call.args).toContain('Test User');
      expect(call.args).toContain('user-123');
    });
  });

  // ==========================================================================
  // retrieve
  // ==========================================================================

  describe('retrieve', () => {
    it('should return null for non-existent credential', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const result = await vault.retrieve('non-existent');
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // delete
  // ==========================================================================

  describe('delete', () => {
    it('should delete credential and return true', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [],
      });

      const result = await vault.delete('cred-1');
      expect(result).toBe(true);
    });

    it('should return false for non-existent credential', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const result = await vault.delete('non-existent');
      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // list
  // ==========================================================================

  describe('list', () => {
    it('should list credentials metadata without decryption', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [
          { id: 'c1', service_id: 'gmail', type: 'oauth2', account_email: 'a@b.com', account_name: 'A', granted_services: '["gmail","drive"]', expires_at: '2024-12-31T00:00:00Z', created_at: '2024-01-01T00:00:00Z' },
          { id: 'c2', service_id: 'brave', type: 'api_key', account_email: null, account_name: null, granted_services: null, expires_at: null, created_at: '2024-01-01T00:00:00Z' },
        ],
        rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const result = await vault.list();
      expect(result).toHaveLength(2);
      expect(result[0].serviceId).toBe('gmail');
      expect(result[0].accountEmail).toBe('a@b.com');
      expect(result[0].grantedServices).toEqual(['gmail', 'drive']);
      expect(result[1].expiresAt).toBeUndefined();
    });

    it('should filter by userId when provided', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      await vault.list('user-123');

      const call = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
      expect(call.sql).toContain('user_id = ');
      expect(call.args).toContain('user-123');
    });
  });

  // ==========================================================================
  // checkHealth
  // ==========================================================================

  describe('checkHealth', () => {
    it('should return valid for non-expired credential', async () => {
      let storedArgs: unknown[] = [];
      vi.mocked(client.execute).mockImplementationOnce(async (input) => {
        storedArgs = (input as { args: unknown[] }).args;
        return { rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] };
      });

      await vault.store('test', 'api_key', { apiKey: 'key' });

      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [{
          id: 'c1', service_id: 'test', type: 'api_key',
          encrypted_data: storedArgs[3], iv: storedArgs[4], auth_tag: storedArgs[5],
          expires_at: null, account_email: null, account_name: null,
        }],
        rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const health = await vault.checkHealth('c1');
      expect(health.valid).toBe(true);
      expect(health.serviceId).toBe('test');
    });

    it('should return invalid for non-existent credential', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const health = await vault.checkHealth('missing');
      expect(health.valid).toBe(false);
      expect(health.error).toContain('not found');
    });
  });

  // ==========================================================================
  // update
  // ==========================================================================

  describe('update', () => {
    it('should update encrypted data', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [],
      });

      const result = await vault.update('cred-1', { apiKey: 'new-key' });
      expect(result).toBe(true);

      const call = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
      expect(call.sql).toContain('UPDATE credentials');
      // Verify encrypted_data, iv, auth_tag are base64 strings
      expect(typeof call.args[0]).toBe('string'); // encrypted_data
      expect(typeof call.args[1]).toBe('string'); // iv
      expect(typeof call.args[2]).toBe('string'); // auth_tag
    });
  });

  // ==========================================================================
  // updateGrantedServices
  // ==========================================================================

  describe('updateGrantedServices', () => {
    it('should update granted_services for an existing credential', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [],
      });

      const result = await vault.updateGrantedServices('cred-1', ['gmail', 'calendar']);
      expect(result).toBe(true);

      const call = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
      expect(call.sql).toContain('UPDATE credentials SET granted_services');
      expect(call.args).toContain('["gmail","calendar"]');
      expect(call.args).toContain('cred-1');
    });

    it('should return false when credential does not exist', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const result = await vault.updateGrantedServices('nonexistent', ['gmail']);
      expect(result).toBe(false);
    });
  });
});
