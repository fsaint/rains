/**
 * Auth Module Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/index.js', () => ({
  config: {
    sessionSecret: 'test-secret-that-is-at-least-32-characters-long!',
    nodeEnv: 'development',
    dashboardUrl: 'http://localhost:5173',
    adminPassword: 'test-admin-pw',
  },
}));

import { signSession, verifySession } from './index.js';

describe('Auth', () => {
  describe('signSession', () => {
    it('should return a JWT string', () => {
      const token = signSession('user-1', 'admin@test.com', 'admin');
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // JWT has 3 parts
    });

    it('should encode user info in the token', () => {
      const token = signSession('user-1', 'admin@test.com', 'admin');
      const payload = verifySession(token);

      expect(payload).not.toBeNull();
      expect(payload!.userId).toBe('user-1');
      expect(payload!.email).toBe('admin@test.com');
      expect(payload!.role).toBe('admin');
    });
  });

  describe('verifySession', () => {
    it('should verify a valid token', () => {
      const token = signSession('user-1', 'test@test.com', 'user');
      const payload = verifySession(token);

      expect(payload).not.toBeNull();
      expect(payload!.userId).toBe('user-1');
      expect(payload!.role).toBe('user');
      expect(payload!.iat).toBeDefined();
    });

    it('should return null for invalid token', () => {
      const payload = verifySession('invalid.token.here');
      expect(payload).toBeNull();
    });

    it('should return null for empty token', () => {
      const payload = verifySession('');
      expect(payload).toBeNull();
    });

    it('should return null for tampered token', () => {
      const token = signSession('user-1', 'test@test.com', 'admin');
      // Tamper with the payload
      const parts = token.split('.');
      parts[1] = Buffer.from('{"userId":"hacker","email":"bad@evil.com","role":"admin"}')
        .toString('base64url');
      const tampered = parts.join('.');

      const payload = verifySession(tampered);
      expect(payload).toBeNull();
    });
  });
});
