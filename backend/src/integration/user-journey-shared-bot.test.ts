/**
 * Integration test: shared-bot agent creation flow
 *
 * Covers the fix where shared-bot users had `telegram_bot_username` always
 * NULL because `getMe` was only called for custom-token users.
 *
 * Key assertions:
 *  - Shared bot flow (no telegramToken in body) calls getMe with the shared
 *    bot token and includes the resolved username in the response.
 *  - getMe failure for a shared bot is non-fatal (still returns 201).
 *  - Custom token still undergoes strict validation (getMe failure → 400).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../config/index.js', () => ({
  config: {
    sessionSecret: 'shared-bot-test-secret-that-is-at-least-32-chars!',
    nodeEnv: 'test',
    dashboardUrl: 'http://localhost:5173',
    adminPassword: 'changeme',
    logLevel: 'silent',
    port: 0,
    host: '127.0.0.1',
    databaseUrl: 'postgres://localhost/test_unused',
    encryptionKey: '0'.repeat(64),
    // Shared bot is configured — this is the key difference from the base suite
    sharedBotToken: 'shared-bot-token-123',
  },
}));

const mockExecute = vi.fn();
vi.mock('../db/index.js', () => ({
  client: { execute: (...args: unknown[]) => mockExecute(...args) },
  initializeDatabase: vi.fn(),
  db: {},
  schema: {},
}));

vi.mock('../providers/index.js', () => ({
  provision: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  getStatus: vi.fn().mockResolvedValue('running'),
  destroy: vi.fn(),
  redeploy: vi.fn(),
  getLogs: vi.fn().mockResolvedValue({ logs: [], nextToken: undefined }),
  getManagementUrl: vi.fn().mockResolvedValue('http://localhost:18789'),
}));

vi.mock('../credentials/vault.js', () => ({
  credentialVault: {
    getValidAccessToken: vi.fn().mockResolvedValue(null),
    retrieve: vi.fn().mockResolvedValue(null),
    store: vi.fn(),
    delete: vi.fn(),
  },
  startTokenRefreshLoop: vi.fn(),
  stopTokenRefreshLoop: vi.fn(),
}));

vi.mock('../mcp/server-manager.js', () => ({
  serverManager: {
    start: vi.fn(),
    stop: vi.fn(),
    getTools: vi.fn().mockResolvedValue([]),
    getStatus: vi.fn().mockReturnValue('stopped'),
    isRunning: vi.fn().mockReturnValue(false),
  },
}));

vi.mock('../mcp/proxy.js', () => ({
  mcpProxy: {
    proxyRequest: vi.fn(),
    getUpstreamTools: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../notifications/apns.js', () => ({
  apnsService: { sendPush: vi.fn() },
}));

vi.mock('../services/email.js', () => ({
  sendReauthEmail: vi.fn(),
}));

vi.mock('@reins/servers', () => ({
  serviceDefinitions: [],
  serviceRegistry: new Map(),
  getServiceTypeFromToolName: () => null,
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { buildApp } from '../app.js';
import { provision } from '../providers/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const EMPTY_RESULT = { rows: [], columns: [], rowsAffected: 0, lastInsertRowid: 0n };

function makeUserRow(passwordHash: string) {
  return {
    id: 'user-shared-bot-1',
    email: 'admin@test.com',
    name: 'Test Admin',
    role: 'admin',
    status: 'active',
    password_hash: passwordHash,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function getMeOk(username: string) {
  return {
    ok: true,
    json: async () => ({ ok: true, result: { id: 999, username, is_bot: true } }),
    text: async () => '{}',
  };
}

function getMeFail() {
  return {
    ok: false,
    json: async () => ({ ok: false, description: 'Not Found' }),
    text: async () => '{"ok":false}',
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Shared-bot agent creation flow', () => {
  let app: FastifyInstance;
  let sessionCookie: string;

  beforeAll(async () => {
    const hash = await bcrypt.hash('testpass123', 10);
    const userRow = makeUserRow(hash);

    mockExecute.mockImplementation(async (input: string | { sql: string; args: unknown[] }) => {
      const sql = typeof input === 'string' ? input : input.sql;
      if (sql.includes('FROM users WHERE email')) {
        return { rows: [userRow], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
      }
      // No existing shared-bot deployment (limit check passes)
      if (sql.includes('is_shared_bot = 1')) {
        return EMPTY_RESULT;
      }
      return EMPTY_RESULT;
    });

    vi.mocked(provision).mockResolvedValue({
      machineId: 'shared-machine-id',
      appName: 'reins-shared-app',
      managementUrl: 'http://localhost:18789',
      volumeId: null,
    });

    app = await buildApp();
    await app.ready();

    // Log in once; session cookie is reused by all tests in this suite
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(getMeOk('SharedBotHelper')));

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@test.com', password: 'testpass123' },
    });
    expect(loginRes.statusCode).toBe(200);
    const setCookie = loginRes.headers['set-cookie'];
    sessionCookie = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.mocked(provision).mockClear();
    vi.mocked(fetch).mockClear();
  });

  // ── Shared bot happy path ─────────────────────────────────────────────────

  describe('1. Shared bot — no custom token provided', () => {
    it('creates agent, calls getMe with shared token, and resolves botUsername', async () => {
      vi.mocked(fetch).mockResolvedValue(getMeOk('SharedBotHelper') as unknown as Response);

      const res = await app.inject({
        method: 'POST',
        url: '/api/agents/create-and-deploy',
        headers: { cookie: sessionCookie },
        payload: {
          name: 'Shared Bot Agent',
          modelProvider: 'anthropic',
          modelName: 'claude-sonnet-4-5',
          telegramUserId: '123456789',
          // No telegramToken → triggers shared bot path
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.data.botUsername).toBe('SharedBotHelper');
      expect(body.data.deployment.status).toBe('running');

      // getMe was called with the shared bot token
      const fetchMock = vi.mocked(fetch);
      const telegramCall = fetchMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('api.telegram.org')
      );
      expect(telegramCall).toBeDefined();
      expect(telegramCall?.[0]).toContain('shared-bot-token-123');
      expect(telegramCall?.[0]).toContain('/getMe');

      // provision received the shared bot token
      const provisionCall = vi.mocked(provision).mock.calls[0]?.[0];
      expect(provisionCall).toBeDefined();
      expect(provisionCall?.telegramToken).toBe('shared-bot-token-123');
    });
  });

  // ── getMe failure is non-fatal for shared bot ─────────────────────────────

  describe('2. Shared bot — getMe failure is non-fatal', () => {
    it('returns 201 even when Telegram getMe returns ok: false', async () => {
      vi.mocked(fetch).mockResolvedValue(getMeFail() as unknown as Response);

      const res = await app.inject({
        method: 'POST',
        url: '/api/agents/create-and-deploy',
        headers: { cookie: sessionCookie },
        payload: {
          name: 'Shared Bot Agent (getMe fail)',
          modelProvider: 'anthropic',
          modelName: 'claude-sonnet-4-5',
          telegramUserId: '123456789',
        },
      });

      // Non-fatal: still deploys, botUsername will be undefined/null
      expect(res.statusCode).toBe(201);
    });

    it('returns 201 even when Telegram getMe throws a network error', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Network timeout'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/agents/create-and-deploy',
        headers: { cookie: sessionCookie },
        payload: {
          name: 'Shared Bot Agent (network fail)',
          modelProvider: 'anthropic',
          modelName: 'claude-sonnet-4-5',
          telegramUserId: '123456789',
        },
      });

      expect(res.statusCode).toBe(201);
    });
  });

  // ── Custom token still strictly validated ─────────────────────────────────

  describe('3. Custom token — still validated even when shared bot is configured', () => {
    it('returns 400 when a custom token fails getMe', async () => {
      vi.mocked(fetch).mockResolvedValue(getMeFail() as unknown as Response);

      const res = await app.inject({
        method: 'POST',
        url: '/api/agents/create-and-deploy',
        headers: { cookie: sessionCookie },
        payload: {
          name: 'Custom Bot Agent',
          telegramToken: 'bad-custom-token',
          modelProvider: 'anthropic',
          modelName: 'claude-sonnet-4-5',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when a custom token getMe throws a network error', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Connection refused'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/agents/create-and-deploy',
        headers: { cookie: sessionCookie },
        payload: {
          name: 'Custom Bot Agent (network fail)',
          telegramToken: 'bad-custom-token',
          modelProvider: 'anthropic',
          modelName: 'claude-sonnet-4-5',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 201 and resolves botUsername when a valid custom token is provided', async () => {
      vi.mocked(fetch).mockResolvedValue(getMeOk('MyCustomBot') as unknown as Response);

      const res = await app.inject({
        method: 'POST',
        url: '/api/agents/create-and-deploy',
        headers: { cookie: sessionCookie },
        payload: {
          name: 'Custom Bot Agent (valid)',
          telegramToken: 'valid-custom-token-123',
          modelProvider: 'anthropic',
          modelName: 'claude-sonnet-4-5',
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().data.botUsername).toBe('MyCustomBot');
    });
  });
});
