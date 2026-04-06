/**
 * Integration test: full user journey
 *
 *   Login → Create Agent → Deploy → Verify gateway URL
 *
 * All external dependencies (DB, providers, Telegram API, MCP servers) are
 * mocked so this test runs with zero external services.  It uses Fastify's
 * built-in `inject()` helper to make real HTTP requests through the full
 * middleware stack — auth guard, cookie parsing, JSON body parsing, etc.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';

// ── Module mocks (hoisted before any imports) ────────────────────────────────

vi.mock('../config/index.js', () => ({
  config: {
    sessionSecret: 'integration-test-secret-that-is-at-least-32-chars!',
    nodeEnv: 'test',
    dashboardUrl: 'http://localhost:5173',
    adminPassword: 'changeme',
    logLevel: 'silent',
    port: 0,
    host: '127.0.0.1',
    databaseUrl: 'postgres://localhost/test_unused',
    encryptionKey: '0'.repeat(64),
  },
}));

// client.execute is wired up in beforeAll once we have the hashed password
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

// ── Import app factory after mocks are in place ───────────────────────────────

import { buildApp } from '../app.js';
import { provision } from '../providers/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const EMPTY_RESULT = { rows: [], columns: [], rowsAffected: 0, lastInsertRowid: 0n };

function makeUserRow(passwordHash: string) {
  return {
    id: 'user-test-1',
    email: 'admin@test.com',
    name: 'Test Admin',
    role: 'admin',
    status: 'active',
    password_hash: passwordHash,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('User Journey — login → create agent → deploy', () => {
  let app: FastifyInstance;
  let sessionCookie: string;
  let createdAgentId: string;
  let deploymentManagementUrl: string;

  beforeAll(async () => {
    const hash = await bcrypt.hash('testpass123', 10);
    const userRow = makeUserRow(hash);

    // Wire DB mock: inspect SQL to return appropriate data
    mockExecute.mockImplementation(async (input: string | { sql: string; args: unknown[] }) => {
      const sql = typeof input === 'string' ? input : input.sql;

      // Login query
      if (sql.includes('FROM users WHERE email')) {
        return { rows: [userRow], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
      }

      // All other queries (INSERTs, UPDATEs, SELECT agents, etc.)
      return EMPTY_RESULT;
    });

    // Provider mock: return a fake deployment
    vi.mocked(provision).mockResolvedValue({
      machineId: 'stub-machine-id',
      appName: 'reins-stub-app',
      managementUrl: 'http://localhost:18789',
    });

    // Telegram validation: mock global fetch for the /getMe call
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { id: 123, username: 'testbot', is_bot: true } }),
      text: async () => '{}',
    }));

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  // ── 1. Health check ──────────────────────────────────────────────────────

  describe('1. Health check', () => {
    it('GET /health returns ok without authentication', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'ok' });
      expect(res.json().timestamp).toBeDefined();
    });
  });

  // ── 2. Authentication ────────────────────────────────────────────────────

  describe('2. Authentication', () => {
    it('rejects missing body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects wrong password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'admin@test.com', password: 'wrongpassword' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
    });

    it('accepts valid credentials and returns session cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'admin@test.com', password: 'testpass123' },
      });
      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.data.authenticated).toBe(true);
      expect(body.data.user.email).toBe('admin@test.com');
      expect(body.data.user.role).toBe('admin');
      expect(body.data.user.id).toBeDefined();

      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      sessionCookie = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
      expect(sessionCookie).toContain('reins_session=');
    });
  });

  // ── 3. Auth guard ────────────────────────────────────────────────────────

  describe('3. Auth guard', () => {
    it('blocks unauthenticated requests to /api/agents', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/agents' });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    });

    it('allows authenticated requests to /api/agents', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/agents',
        headers: { cookie: sessionCookie },
      });
      // 200 with empty agents list (DB mock returns [])
      expect(res.statusCode).toBe(200);
    });
  });

  // ── 4. Agent creation + deployment ──────────────────────────────────────

  describe('4. Create and deploy agent', () => {
    it('validates required fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents/create-and-deploy',
        headers: { cookie: sessionCookie },
        payload: { name: '' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('requires telegramToken', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents/create-and-deploy',
        headers: { cookie: sessionCookie },
        payload: { name: 'My Agent' }, // no telegramToken
      });
      expect(res.statusCode).toBe(400);
    });

    it('creates agent and provisions deployment', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents/create-and-deploy',
        headers: { cookie: sessionCookie },
        payload: {
          name: 'Integration Test Agent',
          telegramToken: 'test-bot-token',
          modelProvider: 'anthropic',
          modelName: 'claude-sonnet-4-5',
        },
      });

      expect(res.statusCode).toBe(201);

      const body = res.json();
      expect(body.data.name).toBe('Integration Test Agent');
      expect(body.data.status).toBe('active');
      expect(body.data.deployment.status).toBe('running');
      expect(body.data.deployment.managementUrl).toBe('http://localhost:18789');
      expect(body.data.deployment.appName).toBe('reins-stub-app');
      expect(body.data.deployment.machineId).toBe('stub-machine-id');

      createdAgentId = body.data.id;
      deploymentManagementUrl = body.data.deployment.managementUrl;

      expect(createdAgentId).toBeDefined();
    });

    it('called provision() with the telegram token', () => {
      const call = vi.mocked(provision).mock.calls[0]?.[0];
      expect(call).toBeDefined();
      expect(call?.telegramToken).toBe('test-bot-token');
    });

    it('called provision() with an MCP config pointing back to Reins', () => {
      const call = vi.mocked(provision).mock.calls[0]?.[0];
      expect(call?.mcpConfigs).toHaveLength(1);
      expect(call?.mcpConfigs[0]).toMatchObject({ name: 'reins', transport: 'http' });
      expect((call?.mcpConfigs[0] as { url: string }).url).toContain(createdAgentId);
    });

    it('called provision() with anthropic model settings', () => {
      const call = vi.mocked(provision).mock.calls[0]?.[0];
      expect(call?.modelProvider).toBe('anthropic');
      expect(call?.modelName).toBe('claude-sonnet-4-5');
    });

    it('called provision() with a gateway token', () => {
      const call = vi.mocked(provision).mock.calls[0]?.[0];
      expect(call?.gatewayToken).toBeTruthy();
      expect(call?.gatewayToken?.length).toBeGreaterThan(8);
    });

    it('validated the Telegram token against the Telegram API', () => {
      const fetchMock = vi.mocked(fetch);
      const telegramCall = fetchMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('api.telegram.org')
      );
      expect(telegramCall).toBeDefined();
      expect(telegramCall?.[0]).toContain('test-bot-token');
      expect(telegramCall?.[0]).toContain('/getMe');
    });
  });

  // ── 5. Deployment URL ────────────────────────────────────────────────────

  describe('5. Deployment management URL', () => {
    it('returns a valid HTTP management URL', () => {
      expect(deploymentManagementUrl).toMatch(/^https?:\/\/.+/);
    });

    it('management URL points to the stub gateway', () => {
      // In a real E2E run with Docker, we'd fetch this URL and verify /healthz.
      // Here we assert the URL is structurally correct.
      expect(deploymentManagementUrl).toBe('http://localhost:18789');
    });
  });

  // ── 6. Second deployment rejected ───────────────────────────────────────

  describe('6. Idempotency guard', () => {
    it('rejects deploying an agent that is already deployed', async () => {
      // existing deployed_agents returns one row
      mockExecute.mockImplementationOnce(async () =>
        // First call inside /api/agents/:id/deploy: SELECT agents WHERE id = ?
        ({ rows: [{ id: 'agent-1', name: 'test', status: 'active', user_id: 'user-test-1' }], columns: [], rowsAffected: 1, lastInsertRowid: 0n })
      ).mockImplementationOnce(async () =>
        // Second call: SELECT deployed_agents WHERE agent_id = ? AND status NOT IN (...)
        ({ rows: [{ id: 'dep-1', status: 'running' }], columns: [], rowsAffected: 1, lastInsertRowid: 0n })
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/agents/agent-1/deploy',
        headers: { cookie: sessionCookie },
        payload: { telegramToken: 'some-token' },
      });

      expect(res.statusCode).toBe(409);
    });
  });
});

// ── Gateway health check (when Docker stub is available) ──────────────────────

describe('Gateway responsiveness (Docker stub)', () => {
  const STUB_URL = process.env.STUB_GATEWAY_URL || 'http://localhost:18789';

  it.skipIf(!process.env.STUB_GATEWAY_URL)(
    'GET /healthz on stub gateway returns ok',
    async () => {
      const res = await fetch(`${STUB_URL}/healthz`);
      expect(res.ok).toBe(true);
      const body = await res.json() as { status: string };
      expect(body.status).toBe('ok');
    }
  );

  it.skipIf(!process.env.STUB_GATEWAY_URL)(
    'GET /api/v1/stats on stub gateway returns token counts',
    async () => {
      const res = await fetch(`${STUB_URL}/api/v1/stats`, {
        headers: { Authorization: 'Bearer test-token' },
      });
      expect(res.ok).toBe(true);
      const body = await res.json() as { totalInputTokens: number };
      expect(typeof body.totalInputTokens).toBe('number');
    }
  );
});
