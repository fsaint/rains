/**
 * Integration test: Memory API end-to-end
 *
 * Exercises all /api/memory/* routes through the full Fastify stack with
 * mocked DB and no external services required.
 *
 * Auth is session-cookie based. Gateway-token auth for agents is tested at
 * the unit level (servers/src/memory/handlers.test.ts) — the auth guard
 * blocks /api/memory/* requests that lack a session cookie, so gateway
 * tokens reaching these routes requires an auth-guard bypass (not yet wired).
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';

// ── Module mocks (hoisted before imports) ────────────────────────────────────

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
  getManagementUrl: vi.fn().mockResolvedValue(null),
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
vi.mock('../services/billing.js', () => ({
  getSubscription: vi.fn().mockResolvedValue(null),
  upsertSubscription: vi.fn().mockResolvedValue(undefined),
  applyGracePeriod: vi.fn().mockResolvedValue(undefined),
  clearGrace: vi.fn().mockResolvedValue(undefined),
  cancelSubscription: vi.fn().mockResolvedValue(undefined),
  checkDeployGate: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('../services/spend.js', () => ({
  checkSpendCap: vi.fn().mockResolvedValue({ allowed: true }),
  recordUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/model-router.js', () => ({
  listModelConfigs: vi.fn().mockResolvedValue([]),
  upsertModelConfig: vi.fn().mockResolvedValue(undefined),
  deleteModelConfig: vi.fn().mockResolvedValue(undefined),
  getLiteLLMConfigB64: vi.fn().mockResolvedValue(null),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { buildApp } from '../app.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const EMPTY = { rows: [], columns: [], rowsAffected: 0, lastInsertRowid: 0n };

const USER_ID = 'user-mem-test-1';
const ROOT_ID = 'root-entry-id';
const ENTRY_ID = 'note-entry-id';
const ATTR_ID = 'attr-label-id';

const NOW = '2026-05-11T12:00:00.000Z';

const rootRow = {
  id: ROOT_ID,
  user_id: USER_ID,
  type: 'index',
  title: 'Memory Index',
  content: '# Memory Index\n\n',
  created_at: NOW,
  updated_at: NOW,
};

const entryRow = {
  id: ENTRY_ID,
  user_id: USER_ID,
  scope_id: 'scope-default-id',
  scope: 'default',
  scope_name: 'Default',
  type: 'person',
  title: 'Alice Smith',
  content: 'Works at Acme Corp.',
  created_at: NOW,
  updated_at: NOW,
};

const attrRow = {
  id: ATTR_ID,
  entry_id: ENTRY_ID,
  type: 'label',
  name: 'tag',
  value: 'contact',
  position: 0,
};

const SCOPE_ID = 'scope-default-id';

// Serves both listUserScopes (which ignores the extra columns) and
// getAgentScopeGrants (which needs them). grant_count 0 means "no grant rows",
// so an agent sees every scope its owner has — the default everywhere.
const scopeRow = {
  id: SCOPE_ID,
  user_id: USER_ID,
  slug: 'default',
  name: 'Default',
  description: null,
  root_entry_id: ROOT_ID,
  is_default: true,
  is_system: true,
  archived_at: null,
  granted: false,
  grant_count: 0,
};

// ── DB mock router ─────────────────────────────────────────────────────────────
//
// Returns fixture data based on which SQL is being executed. Conditions are
// checked in specificity order — more specific patterns first.

function makeDbRouter(passwordHash: string) {
  return async function mockDbExecute(input: string | { sql: string; args: unknown[] }) {
    const sql = typeof input === 'string' ? input : input.sql;

    // ── Auth ──────────────────────────────────────────────────────────────────
    if (sql.includes('FROM users WHERE email')) {
      return {
        rows: [{
          id: USER_ID,
          email: 'admin@test.com',
          name: 'Test User',
          role: 'admin',
          status: 'active',
          password_hash: passwordHash,
          created_at: NOW,
          updated_at: NOW,
        }],
        columns: [], rowsAffected: 1, lastInsertRowid: 0n,
      };
    }

    // ── Scopes (resolveMemoryContext runs on every memory route) ─────────────
    // Must precede the memory_entries branches; every request resolves its
    // scope context before touching an entry.

    // "Is this entry some scope's root?" — more specific than the scope lookup
    // below, so it has to come first or every entry looks like a root.
    if (sql.includes('FROM memory_scopes WHERE root_entry_id = ?')) {
      const isRoot = typeof input !== 'string' && input.args?.[0] === ROOT_ID;
      return { rows: isRoot ? [{ id: SCOPE_ID }] : [], columns: [], rowsAffected: 0, lastInsertRowid: 0n };
    }

    if (sql.includes('FROM memory_scopes')) {
      return { rows: [scopeRow], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
    }

    // ── Graph nodes ───────────────────────────────────────────────────────────
    if (sql.includes('SELECT e.id, e.type, e.title, s.slug AS scope')) {
      return {
        rows: [{ id: ROOT_ID, type: 'index', title: 'Memory Index', scope: 'default' }],
        columns: [], rowsAffected: 1, lastInsertRowid: 0n,
      };
    }

    // ── Memory root check (ensureMemoryRoot + GET /api/memory/root) ───────────
    if (sql.includes("type = 'index'") && sql.includes('FROM memory_entries')) {
      return { rows: [rootRow], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
    }

    // Fetch root by id after ensureMemoryRoot returns the id
    if (sql.startsWith('SELECT id, type, title, content') && sql.includes('FROM memory_entries WHERE id = ?')) {
      return { rows: [rootRow], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
    }

    // ── Reachability / ownership checks, now scope-filtered ───────────────────
    // PUT and DELETE read id+type+scope; setEntryParent reads id+scope; the
    // parent and relation-target checks read scope alone.
    if (sql.startsWith('SELECT id, type, scope_id') ||
        sql.startsWith('SELECT id, scope_id FROM memory_entries')) {
      return {
        rows: [{
          id: ENTRY_ID, type: 'person', scope_id: SCOPE_ID,
          title: 'Alice Smith', content: 'Works at Acme Corp.\n\n## Notes\n\nOld note.\n', version: 1,
        }],
        columns: [], rowsAffected: 1, lastInsertRowid: 0n,
      };
    }
    // PUT retry loop re-read
    if (sql.startsWith('SELECT title, content, version FROM memory_entries')) {
      return {
        rows: [{ title: 'Alice Smith', content: 'Works at Acme Corp.\n\n## Notes\n\nOld note.\n', version: 2 }],
        columns: [], rowsAffected: 1, lastInsertRowid: 0n,
      };
    }
    if (sql.startsWith('SELECT scope_id FROM memory_entries')) {
      return { rows: [{ scope_id: SCOPE_ID }], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
    }

    // ── Full entry fetch (GET /api/memory/entries/:id), now joined to scopes ──
    if (sql.includes('FROM memory_entries e') && sql.includes('JOIN memory_scopes s') && sql.includes('e.id = ?')) {
      return { rows: [entryRow], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
    }

    // PUT — final SELECT after UPDATE
    if (sql.startsWith('SELECT id, user_id, type, title, content, created_at, updated_at') && sql.includes('FROM memory_entries WHERE id = ?')) {
      return { rows: [entryRow], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
    }

    // ── Attributes ────────────────────────────────────────────────────────────
    if (sql.includes('FROM memory_attributes') && sql.includes('entry_id = ?')) {
      return { rows: [attrRow], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
    }

    // Attribute ownership check (DELETE /api/memory/attributes/:attrId)
    if (sql.includes('FROM memory_attributes ma') && sql.includes('ma.id = ?')) {
      return { rows: [{ id: ATTR_ID }], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
    }

    // ── Backlinks ─────────────────────────────────────────────────────────────
    if (sql.includes('FROM memory_links ml') && sql.includes('target_id = ?')) {
      return EMPTY;
    }

    // ── Branch parent lookup ──────────────────────────────────────────────────
    if (sql.includes('FROM memory_branches WHERE entry_id = ?')) {
      return { rows: [{ parent_entry_id: ROOT_ID }], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
    }

    // Branch position for new children
    if (sql.includes('FROM memory_branches') && sql.includes('MAX(position)')) {
      return { rows: [{ next_pos: 1 }], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
    }

    // ── Tree (NULLS FIRST ORDER BY is unique to this query) ──────────────────
    if (sql.includes('NULLS FIRST')) {
      return {
        rows: [
          { id: ROOT_ID, type: 'index', title: 'Memory Index', parent_entry_id: null, position: 0, is_expanded: true },
          { id: ENTRY_ID, type: 'person', title: 'Alice Smith', parent_entry_id: ROOT_ID, position: 0, is_expanded: false },
        ],
        columns: [], rowsAffected: 2, lastInsertRowid: 0n,
      };
    }

    // ── Graph nodes ───────────────────────────────────────────────────────────
    if (sql.startsWith('SELECT id, type, title FROM memory_entries')) {
      return { rows: [{ id: ROOT_ID, type: 'index', title: 'Memory Index' }], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
    }

    // Graph wikilinks
    if (sql.includes('FROM memory_links ml') && sql.includes('JOIN memory_entries s')) {
      return EMPTY;
    }

    // Graph relation attributes
    if (sql.includes("AND ma.type = 'relation'")) {
      return EMPTY;
    }

    // ── Fuzzy match in resolveOrCreate — should not match any entries in tests ──
    if (sql.includes('similarity(')) {
      return EMPTY;
    }

    // ── List / search (catch-all for FROM memory_entries with ORDER BY) ───────
    if (sql.includes('FROM memory_entries') && sql.includes('ORDER BY')) {
      return { rows: [entryRow], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
    }

    if (sql.includes('FROM memory_entries') && sql.includes('plainto_tsquery')) {
      return { rows: [entryRow], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
    }

    // ── Wikilink resolution (updateLinkIndex) ─────────────────────────────────
    if (sql.includes('SELECT id FROM memory_entries WHERE user_id = ? AND title = ?')) {
      return EMPTY;
    }

    // PUT — version-pinned UPDATE must report a hit or the route 409s
    if (sql.startsWith('UPDATE memory_entries SET')) {
      return { rows: [], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
    }
    // PUT — conflict re-read
    if (sql.startsWith('SELECT version, updated_at FROM memory_entries')) {
      return { rows: [{ version: 4, updated_at: NOW }], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
    }

    // ── Default: writes succeed, reads return empty ───────────────────────────
    return EMPTY;
  };
}

// ── Test suite ─────────────────────────────────────────────────────────────────

describe('Memory API — end-to-end', () => {
  let app: FastifyInstance;
  let sessionCookie: string;
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await bcrypt.hash('testpass123', 10);
    mockExecute.mockImplementation(makeDbRouter(passwordHash));

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { id: 123, username: 'testbot', is_bot: true } }),
      text: async () => '{}',
    }));

    app = await buildApp();
    await app.ready();

    // Login to get session cookie
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@test.com', password: 'testpass123' },
    });
    const setCookie = loginRes.headers['set-cookie'];
    sessionCookie = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  });

  // Clear any leaked mockImplementationOnce calls between tests
  afterEach(() => {
    mockExecute.mockReset();
    mockExecute.mockImplementation(makeDbRouter(passwordHash));
  });

  /**
   * Override the next query that is not scope resolution.
   *
   * Every memory route resolves its scope context before touching an entry, so
   * a plain mockImplementationOnce lands on that instead of the query under
   * test. Matching on the query rather than on call order keeps these tests
   * from breaking again the next time a route grows a lookup.
   */
  function overrideNextEntryQuery(result: unknown) {
    const base = makeDbRouter(passwordHash);
    let used = false;
    mockExecute.mockImplementation(async (input: any) => {
      const sql = typeof input === 'string' ? input : input.sql;
      if (!used && !sql.includes('FROM memory_scopes')) {
        used = true;
        return result;
      }
      return base(input);
    });
  }

  afterAll(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  // ── Auth guard ───────────────────────────────────────────────────────────────

  describe('Auth guard', () => {
    it('returns 401 for unauthenticated GET /api/memory/root', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/memory/root' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 for unauthenticated POST /api/memory/entries', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/memory/entries',
        payload: { title: 'Test' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 for requests with only a gateway token (auth guard requires session)', async () => {
      // Gateway token auth for /api/memory/* is not bypassed by the auth guard.
      // Agents use MCP tool calls which go through the servers package; those
      // handlers call the backend with the gateway token but from within the
      // same trusted network. The auth guard bypass for /api/memory/ is a
      // future wiring task (see: resolveMemoryUserId in routes.ts).
      const res = await app.inject({
        method: 'GET',
        url: '/api/memory/root',
        headers: { 'x-reins-agent-secret': 'any-token' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('passes gateway token requests through to route handler for validation', async () => {
      // With the auth guard fixed, a valid gateway token should reach resolveMemoryUserId
      // and get a 200. An invalid token should get 401 from the route handler (not the guard).
      // We verify the guard passes it through by checking the invalid token gets 401 (not a
      // generic "UNAUTHORIZED" code — route handler returns plain { error: 'Unauthorized' }).
      const res = await app.inject({
        method: 'GET',
        url: '/api/memory/root',
        headers: { 'x-reins-agent-secret': 'invalid-token-should-reach-handler' },
      });
      // Route handler returns { error: 'Unauthorized' } (string), not { error: { code: 'UNAUTHORIZED' } }
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Unauthorized');
    });
  });

  // ── GET /api/memory/root ─────────────────────────────────────────────────────

  describe('GET /api/memory/root', () => {
    it('returns the memory root entry', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/memory/root',
        headers: { cookie: sessionCookie },
      });

      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data.id).toBe(ROOT_ID);
      expect(data.title).toBe('Memory Index');
      expect(data.type).toBe('index');
    });

    it('creates root on first call if none exists', async () => {
      // Override: root lookup returns empty → triggers creation path.
      // Scope resolution is served from the fixture and does not advance the
      // sequence, so this stays about the root path rather than about how many
      // queries happen to precede it.
      const createSequence: Array<Record<string, unknown>[]> = [
        [],          // INSERT memory_entries
        [],          // INSERT memory_branches
        [],          // UPDATE memory_scopes.root_entry_id
        [rootRow],   // SELECT by id after creation
      ];
      let idx = 0;
      mockExecute.mockImplementation(async (input: any) => {
        const sql = typeof input === 'string' ? input : input.sql;
        // A scope whose root_entry_id is null is what triggers creation.
        if (sql.includes('FROM memory_scopes')) {
          return {
            rows: [{ ...scopeRow, root_entry_id: null }],
            columns: [], rowsAffected: 1, lastInsertRowid: 0n,
          };
        }
        return {
          rows: createSequence[idx++] ?? [],
          columns: [], rowsAffected: 0, lastInsertRowid: 0n,
        };
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/memory/root',
        headers: { cookie: sessionCookie },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.title).toBe('Memory Index');
    });
  });

  // ── POST /api/memory/entries ─────────────────────────────────────────────────

  describe('POST /api/memory/entries', () => {
    it('returns 400 when title is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/memory/entries',
        headers: { cookie: sessionCookie },
        payload: { type: 'note' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('title');
    });

    it('creates an entry and returns 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/memory/entries',
        headers: { cookie: sessionCookie },
        payload: {
          title: 'Alice Smith',
          type: 'person',
          content: 'Works at Acme Corp.',
          parent_id: ROOT_ID,
        },
      });

      expect(res.statusCode).toBe(201);
      const { data } = res.json();
      expect(data.title).toBe('Alice Smith');
      expect(data.type).toBe('person');
    });

    it('defaults type to note', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/memory/entries',
        headers: { cookie: sessionCookie },
        payload: { title: 'Quick note' },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().data.type).toBe('note');
    });

    it('creates initial attributes when provided', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/memory/entries',
        headers: { cookie: sessionCookie },
        payload: {
          title: 'Tagged Entry',
          attributes: [{ type: 'label', name: 'tag', value: 'important' }],
        },
      });

      expect(res.statusCode).toBe(201);
    });
  });

  // ── GET /api/memory/entries/:id ──────────────────────────────────────────────

  describe('GET /api/memory/entries/:id', () => {
    it('returns the entry with attributes and backlinks', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/memory/entries/${ENTRY_ID}`,
        headers: { cookie: sessionCookie },
      });

      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data.id).toBe(ENTRY_ID);
      expect(data.title).toBe('Alice Smith');
      expect(Array.isArray(data.attributes)).toBe(true);
      expect(Array.isArray(data.backlinks)).toBe(true);
      expect(data.parentId).toBeDefined();
    });

    it('returns 404 for an unknown entry', async () => {
      // Override: entry lookup returns empty → 404
      overrideNextEntryQuery(EMPTY);

      const res = await app.inject({
        method: 'GET',
        url: '/api/memory/entries/nonexistent-id',
        headers: { cookie: sessionCookie },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ── PUT /api/memory/entries/:id ──────────────────────────────────────────────

  describe('PUT /api/memory/entries/:id', () => {
    it('updates title and content', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/entries/${ENTRY_ID}`,
        headers: { cookie: sessionCookie },
        payload: { title: 'Alice Smith (updated)', content: 'Updated content' },
      });

      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data).toBeDefined();
    });

    it('returns 404 when entry does not belong to user', async () => {
      // Override: ownership SELECT returns empty
      overrideNextEntryQuery(EMPTY);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/memory/entries/other-users-entry',
        headers: { cookie: sessionCookie },
        payload: { title: 'Hacked' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('bumps version and scopes the UPDATE itself', async () => {
      mockExecute.mockClear(); // calls accumulate across tests in this file
      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/entries/${ENTRY_ID}`,
        headers: { cookie: sessionCookie },
        payload: { content: 'Updated' },
      });

      expect(res.statusCode).toBe(200);
      const update = mockExecute.mock.calls
        .map(([q]: any[]) => (typeof q === 'string' ? q : q.sql))
        .find((s: string) => s.startsWith('UPDATE memory_entries SET'));
      expect(update).toContain('version = version + 1');
      // The write re-asserts reachability; the pre-SELECT alone is a TOCTOU.
      expect(update).toContain('scope_id IN');
      // Even without if_version the write is pinned to the version just read.
      expect(update).toContain('AND version = ?');
    });

    it('pins the update to if_version when given', async () => {
      mockExecute.mockClear();
      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/entries/${ENTRY_ID}`,
        headers: { cookie: sessionCookie },
        payload: { content: 'Updated', if_version: 3 },
      });

      expect(res.statusCode).toBe(200);
      const call = mockExecute.mock.calls
        .map(([q]: any[]) => (typeof q === 'string' ? { sql: q, args: [] } : q))
        .find((q: { sql: string }) => q.sql.startsWith('UPDATE memory_entries SET'));
      expect(call.sql).toContain('AND version = ?');
      expect(call.args).toContain(3);
    });

    it('returns 409 VERSION_CONFLICT with the current version when the token is stale', async () => {
      // The version-pinned UPDATE misses; the route re-reads and reports.
      const base = mockExecute.getMockImplementation()!;
      let missed = false;
      mockExecute.mockImplementation(async (input: any) => {
        const sql = typeof input === 'string' ? input : input.sql;
        if (!missed && sql.startsWith('UPDATE memory_entries SET')) {
          missed = true;
          return EMPTY;
        }
        return base(input);
      });

      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/entries/${ENTRY_ID}`,
        headers: { cookie: sessionCookie },
        payload: { content: 'Stale write', if_version: 3 },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.code).toBe('VERSION_CONFLICT');
      expect(body.current_version).toBe(4);
      expect(body.error).toContain('version 4');
      expect(body.error).toContain('Re-read');
    });

    it('rejects a non-integer if_version with 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/entries/${ENTRY_ID}`,
        headers: { cookie: sessionCookie },
        payload: { content: 'x', if_version: 'three' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_VERSION');
    });

    it('append adds on a new line and re-indexes with the joined content', async () => {
      mockExecute.mockClear();
      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/entries/${ENTRY_ID}`,
        headers: { cookie: sessionCookie },
        payload: { append: '- met at the #acme offsite' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.applied).toBe('append');
      const update = mockExecute.mock.calls
        .map(([q]: any[]) => (typeof q === 'string' ? { sql: q, args: [] as unknown[] } : q))
        .find((q: { sql: string }) => q.sql.startsWith('UPDATE memory_entries SET'));
      expect(update.args).toContain('Works at Acme Corp.\n\n## Notes\n\nOld note.\n- met at the #acme offsite\n');
      // The tag index must be rebuilt from the joined content, not the fragment.
      const tagInsert = mockExecute.mock.calls
        .map(([q]: any[]) => (typeof q === 'string' ? { sql: q, args: [] as unknown[] } : q))
        .find((q: { sql: string }) => q.sql.includes('INSERT INTO memory_tags'));
      expect(tagInsert).toBeDefined();
      expect(tagInsert.args).toContain('acme');
    });

    it('section replace rewrites only that heading', async () => {
      mockExecute.mockClear();
      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/entries/${ENTRY_ID}`,
        headers: { cookie: sessionCookie },
        payload: { section: { heading: 'Notes', text: 'Fresh note.' } },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.applied).toBe('section');
      const update = mockExecute.mock.calls
        .map(([q]: any[]) => (typeof q === 'string' ? { sql: q, args: [] as unknown[] } : q))
        .find((q: { sql: string }) => q.sql.startsWith('UPDATE memory_entries SET'));
      const written = update.args.find((a: unknown) => typeof a === 'string' && (a as string).includes('## Notes'));
      expect(written).toContain('Works at Acme Corp.');
      expect(written).toContain('## Notes\n\nFresh note.');
      expect(written).not.toContain('Old note.');
    });

    it('section append creates a missing heading and reports it', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/entries/${ENTRY_ID}`,
        headers: { cookie: sessionCookie },
        payload: { section: { heading: 'Sources', text: '- intro call', mode: 'append' } },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.section_created).toBe(true);
    });

    it('section replace on a missing heading is 404 SECTION_NOT_FOUND listing the headings', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/entries/${ENTRY_ID}`,
        headers: { cookie: sessionCookie },
        payload: { section: { heading: 'Nope', text: 'x' } },
      });

      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.code).toBe('SECTION_NOT_FOUND');
      expect(body.headings).toEqual(['Notes']);
      expect(body.error).toContain('mode "append"');
    });

    it('refuses content together with append', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/entries/${ENTRY_ID}`,
        headers: { cookie: sessionCookie },
        payload: { content: 'x', append: 'y' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('CONFLICTING_CONTENT_OPS');
    });

    it('rejects a malformed section', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/entries/${ENTRY_ID}`,
        headers: { cookie: sessionCookie },
        payload: { section: { heading: '', text: 'x' } },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_SECTION');
    });

    it('retries against fresh content when the row moved under an append without if_version', async () => {
      mockExecute.mockClear();
      const base = mockExecute.getMockImplementation()!;
      let missed = false;
      mockExecute.mockImplementation(async (input: any) => {
        const sql = typeof input === 'string' ? input : input.sql;
        if (!missed && sql.startsWith('UPDATE memory_entries SET')) {
          missed = true;
          return EMPTY;
        }
        return base(input);
      });

      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/entries/${ENTRY_ID}`,
        headers: { cookie: sessionCookie },
        payload: { append: '- survived the race' },
      });

      expect(res.statusCode).toBe(200);
      const updates = mockExecute.mock.calls
        .map(([q]: any[]) => (typeof q === 'string' ? q : q.sql))
        .filter((s: string) => s.startsWith('UPDATE memory_entries SET'));
      expect(updates).toHaveLength(2);
    });

    it('does not retry when if_version was given', async () => {
      mockExecute.mockClear();
      const base = mockExecute.getMockImplementation()!;
      mockExecute.mockImplementation(async (input: any) => {
        const sql = typeof input === 'string' ? input : input.sql;
        if (sql.startsWith('UPDATE memory_entries SET')) return EMPTY;
        return base(input);
      });

      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/entries/${ENTRY_ID}`,
        headers: { cookie: sessionCookie },
        payload: { append: '- stale', if_version: 1 },
      });

      expect(res.statusCode).toBe(409);
      const updates = mockExecute.mock.calls
        .map(([q]: any[]) => (typeof q === 'string' ? q : q.sql))
        .filter((s: string) => s.startsWith('UPDATE memory_entries SET'));
      expect(updates).toHaveLength(1);
    });
  });

  // ── GET /api/memory/entries (list / search) ──────────────────────────────────

  describe('GET /api/memory/entries', () => {
    it('returns a list of entries', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/memory/entries',
        headers: { cookie: sessionCookie },
      });

      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(Array.isArray(data)).toBe(true);
    });

    it('filters by type', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/memory/entries?type=person',
        headers: { cookie: sessionCookie },
      });

      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().data)).toBe(true);
    });

    it('searches with full-text query', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/memory/entries?q=alice',
        headers: { cookie: sessionCookie },
      });

      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().data)).toBe(true);
    });

    it('filters by parent_id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/memory/entries?parent_id=${ROOT_ID}`,
        headers: { cookie: sessionCookie },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // ── GET /api/memory/tree ─────────────────────────────────────────────────────

  describe('GET /api/memory/tree', () => {
    it('returns the full entry tree with root first', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/memory/tree',
        headers: { cookie: sessionCookie },
      });

      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(1);
      const root = data.find((e: any) => e.type === 'index');
      expect(root).toBeDefined();
      expect(root.title).toBe('Memory Index');
    });

    it('includes child entries with parent references', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/memory/tree',
        headers: { cookie: sessionCookie },
      });

      const { data } = res.json();
      const child = data.find((e: any) => e.id === ENTRY_ID);
      expect(child).toBeDefined();
      expect(child.parent_entry_id).toBe(ROOT_ID);
    });
  });

  // ── GET /api/memory/graph ────────────────────────────────────────────────────

  describe('GET /api/memory/graph', () => {
    it('returns nodes and edges', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/memory/graph',
        headers: { cookie: sessionCookie },
      });

      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(Array.isArray(data.nodes)).toBe(true);
      expect(Array.isArray(data.edges)).toBe(true);
    });

    it('nodes contain id, type, and title', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/memory/graph',
        headers: { cookie: sessionCookie },
      });

      const { nodes } = res.json().data;
      expect(nodes.length).toBeGreaterThan(0);
      expect(nodes[0]).toMatchObject({ id: ROOT_ID, type: 'index', title: 'Memory Index' });
    });
  });

  // ── POST /api/memory/entries/:id/attributes ──────────────────────────────────

  describe('POST /api/memory/entries/:id/attributes', () => {
    it('returns 400 when required fields are missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/memory/entries/${ENTRY_ID}/attributes`,
        headers: { cookie: sessionCookie },
        payload: { type: 'label' }, // missing name and value
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('type, name, value required');
    });

    it('returns 400 for invalid attribute type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/memory/entries/${ENTRY_ID}/attributes`,
        headers: { cookie: sessionCookie },
        payload: { type: 'invalid', name: 'foo', value: 'bar' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('label or relation');
    });

    it('adds a label attribute and returns 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/memory/entries/${ENTRY_ID}/attributes`,
        headers: { cookie: sessionCookie },
        payload: { type: 'label', name: 'tag', value: 'contact' },
      });

      expect(res.statusCode).toBe(201);
      const { data } = res.json();
      expect(data.type).toBe('label');
      expect(data.name).toBe('tag');
      expect(data.value).toBe('contact');
      expect(data.entryId).toBe(ENTRY_ID);
    });

    it('adds a relation attribute', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/memory/entries/${ENTRY_ID}/attributes`,
        headers: { cookie: sessionCookie },
        payload: { type: 'relation', name: 'knows', value: ROOT_ID },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().data.type).toBe('relation');
    });

    it('returns 404 when entry does not belong to user', async () => {
      // Override: ownership check returns empty
      overrideNextEntryQuery(EMPTY);

      const res = await app.inject({
        method: 'POST',
        url: '/api/memory/entries/other-users-entry/attributes',
        headers: { cookie: sessionCookie },
        payload: { type: 'label', name: 'tag', value: 'x' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ── DELETE /api/memory/attributes/:attrId ────────────────────────────────────

  describe('DELETE /api/memory/attributes/:attrId', () => {
    it('soft-deletes the attribute', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/memory/attributes/${ATTR_ID}`,
        headers: { cookie: sessionCookie },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it('returns 404 when attribute not found', async () => {
      // Override: attribute ownership check returns empty
      overrideNextEntryQuery(EMPTY);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/memory/attributes/nonexistent-attr',
        headers: { cookie: sessionCookie },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ── DELETE /api/memory/entries/:id ──────────────────────────────────────────

  describe('DELETE /api/memory/entries/:id', () => {
    it('soft-deletes the entry (UPDATE is_deleted = true)', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/memory/entries/${ENTRY_ID}`,
        headers: { cookie: sessionCookie },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // ── GET /api/memory/dream ────────────────────────────────────────────────────

  describe('GET /api/memory/dream', () => {
    it('returns compact manifest of all entries', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/memory/dream',
        headers: { cookie: sessionCookie },
      });

      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data[0]).toMatchObject({
        id: expect.any(String),
        title: expect.any(String),
        type: expect.any(String),
        backlink_count: expect.any(Number),
        updated_at: expect.any(String),
      });
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/memory/dream' });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── PUT /api/memory/entries/:id/parent ───────────────────────────────────────

  describe('PUT /api/memory/entries/:id/parent', () => {
    it('returns 200 and { ok: true } on success', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/entries/${ENTRY_ID}/parent`,
        headers: { cookie: sessionCookie },
        payload: { parent_id: ROOT_ID },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ ok: true });
    });

    it('returns 400 for self-parent', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/entries/${ENTRY_ID}/parent`,
        headers: { cookie: sessionCookie },
        payload: { parent_id: ENTRY_ID },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBeTruthy();
    });

    it('returns 404 when entry not found', async () => {
      overrideNextEntryQuery({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });

      const res = await app.inject({
        method: 'PUT',
        url: '/api/memory/entries/nonexistent/parent',
        headers: { cookie: sessionCookie },
        payload: { parent_id: ROOT_ID },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/entries/${ENTRY_ID}/parent`,
        payload: { parent_id: ROOT_ID },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── Root read-only enforcement ────────────────────────────────────────────────

  describe('Root read-only enforcement', () => {
    it('returns 403 when session user tries to update root index entry', async () => {
      // Override: ownership check returns a root entry (type = 'index')
      overrideNextEntryQuery({
        rows: [{ id: ROOT_ID, type: 'index' }],
        rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const res = await app.inject({
        method: 'PUT',
        url: `/api/memory/entries/${ROOT_ID}`,
        headers: { cookie: sessionCookie },
        payload: { content: 'hacked' },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain('agent');
    });
  });

  // ── Regression: the memory work dropped by bfce9eb ───────────────────────────
  //
  // That commit rewrote routes.ts and silently reverted six commits' worth of
  // memory features while their service functions, MCP handlers, frontend
  // callers and docs all stayed in place. Each test here pins one of the
  // behaviours something else already depends on.

  describe('regressions from bfce9eb', () => {
    /** Layer a case on top of the standard router without restating it. */
    function withRouter(extra: (sql: string) => unknown | undefined) {
      const base = makeDbRouter(passwordHash);
      mockExecute.mockImplementation(async (input: any) => {
        const sql = typeof input === 'string' ? input : input.sql;
        const hit = extra(sql);
        if (hit !== undefined) return hit;
        return base(input);
      });
    }

    /** Every SQL string the route issued, for asserting on query shape. */
    const sqlCalls = () =>
      mockExecute.mock.calls.map((c: any) => (typeof c[0] === 'string' ? c[0] : c[0]?.sql ?? ''));

    describe('GET /api/memory/tags', () => {
      // memory_list_tags (servers/src/memory/handlers.ts) and the dashboard's
      // client.listTags both call this; it 404'd for both.
      it('returns tags with counts, most used first', async () => {
        withRouter((sql) =>
          sql.includes('FROM memory_tags mt')
            ? { rows: [{ tag: 'acme', count: 3 }, { tag: 'travel', count: 1 }], columns: [], rowsAffected: 2, lastInsertRowid: 0n }
            : undefined
        );

        const res = await app.inject({
          method: 'GET', url: '/api/memory/tags', headers: { cookie: sessionCookie },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().data).toEqual([
          { tag: 'acme', count: 3 },
          { tag: 'travel', count: 1 },
        ]);
      });

      it('requires auth', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/memory/tags' });
        expect(res.statusCode).toBe(401);
      });
    });

    describe('GET /api/memory/entries filters', () => {
      // memory_list sets these three on the query string; the route parsed only
      // q/type/parent_id, so they were accepted and silently ignored.
      it('joins memory_tags when filtering by tag', async () => {
        const res = await app.inject({
          method: 'GET', url: '/api/memory/entries?tag=acme', headers: { cookie: sessionCookie },
        });

        expect(res.statusCode).toBe(200);
        const listQuery = sqlCalls().find((s) => s.includes('JOIN memory_tags mt'));
        expect(listQuery).toBeDefined();
      });

      it('applies `since` as an updated_at floor', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/memory/entries?since=2026-01-01T00:00:00.000Z',
          headers: { cookie: sessionCookie },
        });

        expect(res.statusCode).toBe(200);
        expect(sqlCalls().some((s) => s.includes('e.updated_at >= ?'))).toBe(true);
      });

      it('honours `order`, defaulting to most recently updated', async () => {
        await app.inject({
          method: 'GET', url: '/api/memory/entries?order=title', headers: { cookie: sessionCookie },
        });
        expect(sqlCalls().some((s) => s.includes('ORDER BY e.title ASC'))).toBe(true);

        mockExecute.mockClear();
        await app.inject({
          method: 'GET', url: '/api/memory/entries', headers: { cookie: sessionCookie },
        });
        expect(sqlCalls().some((s) => s.includes('ORDER BY e.updated_at DESC'))).toBe(true);
      });

      it('looks up an exact title case-insensitively, without ts_rank', async () => {
        const res = await app.inject({
          method: 'GET', url: '/api/memory/entries?title=alice%20smith', headers: { cookie: sessionCookie },
        });

        expect(res.statusCode).toBe(200);
        const titleQuery = sqlCalls().find((s) => s.includes('LOWER(e.title) = LOWER(?)'));
        expect(titleQuery).toBeDefined();
        expect(titleQuery).not.toContain('plainto_tsquery');
      });

      it('title takes precedence over q', async () => {
        await app.inject({
          method: 'GET', url: '/api/memory/entries?title=alice&q=bob', headers: { cookie: sessionCookie },
        });

        expect(sqlCalls().some((s) => s.includes('LOWER(e.title)'))).toBe(true);
        expect(sqlCalls().some((s) => s.includes('plainto_tsquery'))).toBe(false);
      });

      it('title lookup binds type', async () => {
        await app.inject({
          method: 'GET', url: '/api/memory/entries?title=alice&type=person', headers: { cookie: sessionCookie },
        });

        const titleQuery = sqlCalls().find((s) => s.includes('LOWER(e.title)'));
        expect(titleQuery).toContain('AND e.type = ?');
      });

      it('binds `type` rather than interpolating it', async () => {
        await app.inject({
          method: 'GET',
          url: `/api/memory/entries?type=${encodeURIComponent("person' OR '1'='1")}`,
          headers: { cookie: sessionCookie },
        });

        // The value must never appear inside the SQL text itself.
        expect(sqlCalls().some((s) => s.includes("OR '1'='1"))).toBe(false);
      });
    });

    describe('POST /api/memory/entries idempotency', () => {
      // MEMORY_POLICY.md instructs agents to branch on `created`. The route did a
      // raw INSERT and always returned 201, so `created` was a lie and repeated
      // observations about one person accumulated duplicates.
      it('returns 200 and the existing row when the title already exists', async () => {
        withRouter((sql) =>
          // resolveOrCreate's exact-match lookup, now keyed on scope
          sql.includes('WHERE scope_id = ? AND type = ? AND title = ?')
            ? { rows: [entryRow], columns: [], rowsAffected: 1, lastInsertRowid: 0n }
            : undefined
        );

        const res = await app.inject({
          method: 'POST', url: '/api/memory/entries', headers: { cookie: sessionCookie },
          payload: { title: 'Alice Smith', type: 'person', content: 'Met again today.' },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().data.id).toBe(ENTRY_ID);
        // The whole point: no second row for the same person.
        expect(sqlCalls().some((s) => s.includes('INSERT INTO memory_entries'))).toBe(false);
      });

      it('still returns 201 and inserts when nothing matches', async () => {
        const res = await app.inject({
          method: 'POST', url: '/api/memory/entries', headers: { cookie: sessionCookie },
          payload: { title: 'Brand New Person', type: 'person' },
        });

        expect(res.statusCode).toBe(201);
        expect(sqlCalls().some((s) => s.includes('INSERT INTO memory_entries'))).toBe(true);
      });

      it('indexes tags from the content it just wrote', async () => {
        await app.inject({
          method: 'POST', url: '/api/memory/entries', headers: { cookie: sessionCookie },
          payload: { title: 'Tagged Note', content: 'Lunch with the #acme team.' },
        });

        // Without this, memory_tags stays empty and GET /api/memory/tags — and
        // ?tag= filtering — return nothing however correct their SQL is.
        const insert = mockExecute.mock.calls
          .map((c: any) => c[0])
          .find((q: any) => typeof q?.sql === 'string' && q.sql.includes('INSERT INTO memory_tags'));
        expect(insert).toBeDefined();
        expect(insert.args).toContain('acme');
      });
    });

    describe('PUT /api/memory/entries/:id', () => {
      it('re-indexes tags when the content changes', async () => {
        await app.inject({
          method: 'PUT', url: `/api/memory/entries/${ENTRY_ID}`, headers: { cookie: sessionCookie },
          payload: { content: 'Now about #travel instead.' },
        });

        expect(sqlCalls().some((s) => s.includes('DELETE FROM memory_tags'))).toBe(true);
        const insert = mockExecute.mock.calls
          .map((c: any) => c[0])
          .find((q: any) => typeof q?.sql === 'string' && q.sql.includes('INSERT INTO memory_tags'));
        expect(insert.args).toContain('travel');
      });
    });

    describe('GET /api/memory/entries/:id enrichment', () => {
      // frontend/src/api/client.ts types these as required and MemoryEntry.tsx
      // reads them; `entry.tags.map` at :395 throws outright when tags is absent.
      it('returns tags, resolvedLinks, resolvedHeadings and transclusions', async () => {
        const res = await app.inject({
          method: 'GET', url: `/api/memory/entries/${ENTRY_ID}`, headers: { cookie: sessionCookie },
        });

        expect(res.statusCode).toBe(200);
        const { data } = res.json();
        expect(Array.isArray(data.tags)).toBe(true);
        expect(data.resolvedLinks).toBeDefined();
        expect(data.resolvedHeadings).toBeDefined();
        expect(data.transclusions).toBeDefined();
      });

      it('resolves a [[wikilink]] in the content to an entry id', async () => {
        withRouter((sql) => {
          if (sql.includes('FROM memory_entries e') && sql.includes('JOIN memory_scopes s') && sql.includes('e.id = ?')) {
            return {
              rows: [{ ...entryRow, content: 'Reports to [[Bob Jones#Role]].' }],
              columns: [], rowsAffected: 1, lastInsertRowid: 0n,
            };
          }
          if (sql.includes('AND title IN (')) {
            return { rows: [{ id: 'bob-id', title: 'Bob Jones' }], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
          }
          return undefined;
        });

        const res = await app.inject({
          method: 'GET', url: `/api/memory/entries/${ENTRY_ID}`, headers: { cookie: sessionCookie },
        });

        const { data } = res.json();
        expect(data.resolvedLinks['Bob Jones']).toBe('bob-id');
        expect(data.resolvedHeadings['Bob Jones']).toBe('Role');
      });
    });
  });

  // ── Scopes ───────────────────────────────────────────────────────────────
  //
  // The partition itself. A scope the caller cannot reach must be
  // indistinguishable from one that does not exist, and nothing — parents,
  // relations, links — may cross between them.

  describe('scopes', () => {
    /** Two scopes, both reachable, `default` being the write target. */
    function twoScopes() {
      const base = makeDbRouter(passwordHash);
      mockExecute.mockImplementation(async (input: any) => {
        const sql = typeof input === 'string' ? input : input.sql;
        if (sql.includes('FROM memory_scopes WHERE root_entry_id = ?')) {
          return { rows: [], columns: [], rowsAffected: 0, lastInsertRowid: 0n };
        }
        if (sql.includes('FROM memory_scopes')) {
          return {
            rows: [
              scopeRow,
              { ...scopeRow, id: 'scope-work-id', slug: 'work', name: 'Work', is_default: false, is_system: false },
            ],
            columns: [], rowsAffected: 2, lastInsertRowid: 0n,
          };
        }
        return base(input);
      });
    }

    const sqlCalls = () =>
      mockExecute.mock.calls.map((c: any) => (typeof c[0] === 'string' ? c[0] : c[0]?.sql ?? ''));
    const argsOf = (pattern: string) =>
      (mockExecute.mock.calls
        .map((c: any) => c[0])
        .find((q: any) => typeof q?.sql === 'string' && q.sql.includes(pattern))?.args ?? []) as unknown[];

    describe('GET /api/memory/scopes', () => {
      it('lists reachable scopes with entry counts', async () => {
        twoScopes();

        const res = await app.inject({
          method: 'GET', url: '/api/memory/scopes', headers: { cookie: sessionCookie },
        });

        expect(res.statusCode).toBe(200);
        const slugs = res.json().data.map((s: any) => s.slug);
        expect(slugs).toEqual(['default', 'work']);
        expect(res.json().data[0]).toHaveProperty('entry_count');
      });
    });

    describe('reads', () => {
      it('spans every reachable scope when none is named', async () => {
        twoScopes();

        await app.inject({
          method: 'GET', url: '/api/memory/entries', headers: { cookie: sessionCookie },
        });

        // Both scope ids reach the WHERE clause.
        const args = argsOf('e.scope_id IN');
        expect(args).toContain('scope-default-id');
        expect(args).toContain('scope-work-id');
      });

      it('narrows to one scope when named by slug', async () => {
        twoScopes();

        const res = await app.inject({
          method: 'GET', url: '/api/memory/entries?scope=work', headers: { cookie: sessionCookie },
        });

        expect(res.statusCode).toBe(200);
        const args = argsOf('e.scope_id IN');
        expect(args).toContain('scope-work-id');
        expect(args).not.toContain('scope-default-id');
      });

      it('rejects an unreachable scope with 403 and the usable slugs', async () => {
        twoScopes();

        const res = await app.inject({
          method: 'GET', url: '/api/memory/entries?scope=finance', headers: { cookie: sessionCookie },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('SCOPE_NOT_GRANTED');
        // Returning the list is the point — a model can correct itself next call.
        expect(res.json().available_scopes).toEqual(['default', 'work']);
      });

      it('labels every row with the scope it came from', async () => {
        twoScopes();

        const res = await app.inject({
          method: 'GET', url: '/api/memory/entries', headers: { cookie: sessionCookie },
        });

        expect(sqlCalls().some((s) => s.includes('s.slug AS scope'))).toBe(true);
        expect(res.json().data[0]).toHaveProperty('scope');
      });
    });

    describe('writes', () => {
      it('lands in the default scope when none is named', async () => {
        twoScopes();

        await app.inject({
          method: 'POST', url: '/api/memory/entries', headers: { cookie: sessionCookie },
          payload: { title: 'Unscoped Note' },
        });

        expect(argsOf('INSERT INTO memory_entries')).toContain('scope-default-id');
      });

      it('lands in the named scope when one is given', async () => {
        twoScopes();

        await app.inject({
          method: 'POST', url: '/api/memory/entries', headers: { cookie: sessionCookie },
          payload: { title: 'Work Note', scope: 'work' },
        });

        expect(argsOf('INSERT INTO memory_entries')).toContain('scope-work-id');
      });

      it('inherits the parent\'s scope when no scope is named', async () => {
        // "Create this under that entry" should do the obvious thing without the
        // model reasoning about scopes at all.
        twoScopes();

        await app.inject({
          method: 'POST', url: '/api/memory/entries', headers: { cookie: sessionCookie },
          payload: { title: 'Child', parent_id: ENTRY_ID },
        });

        // The fixture's parent sits in the default scope.
        expect(argsOf('INSERT INTO memory_entries')).toContain(SCOPE_ID);
      });

      it('refuses a scope that contradicts the parent, rather than picking one', async () => {
        twoScopes();

        const res = await app.inject({
          method: 'POST', url: '/api/memory/entries', headers: { cookie: sessionCookie },
          payload: { title: 'Contradiction', scope: 'work', parent_id: ENTRY_ID },
        });

        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('SCOPE_CONFLICT');
      });

      it('refuses to patch an entry\'s scope through the update route', async () => {
        twoScopes();

        const res = await app.inject({
          method: 'PUT', url: `/api/memory/entries/${ENTRY_ID}`, headers: { cookie: sessionCookie },
          payload: { scope: 'work' },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('SCOPE_NOT_PATCHABLE');
      });
    });

    describe('cross-scope integrity', () => {
      it('refuses a relation whose target is in another scope', async () => {
        // The one cross-scope rule with no database constraint behind it —
        // memory_attributes.value is polymorphic, so no FK can be declared.
        twoScopes();
        const base = makeDbRouter(passwordHash);
        mockExecute.mockImplementation(async (input: any) => {
          const sql = typeof input === 'string' ? input : input.sql;
          if (sql.includes('FROM memory_scopes WHERE root_entry_id = ?')) return { rows: [], columns: [], rowsAffected: 0, lastInsertRowid: 0n };
          if (sql.includes('FROM memory_scopes')) {
            return {
              rows: [scopeRow, { ...scopeRow, id: 'scope-work-id', slug: 'work', is_default: false }],
              columns: [], rowsAffected: 2, lastInsertRowid: 0n,
            };
          }
          // The source is in default; the relation target is in work.
          if (sql.startsWith('SELECT scope_id FROM memory_entries')) {
            return { rows: [{ scope_id: 'scope-work-id' }], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
          }
          return base(input);
        });

        const res = await app.inject({
          method: 'POST', url: `/api/memory/entries/${ENTRY_ID}/attributes`,
          headers: { cookie: sessionCookie },
          payload: { type: 'relation', name: 'works_at', value: 'entry-in-work' },
        });

        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('CROSS_SCOPE_RELATION');
      });

      it('keeps graph relation edges inside a single scope', async () => {
        twoScopes();

        await app.inject({
          method: 'GET', url: '/api/memory/graph', headers: { cookie: sessionCookie },
        });

        const relationQuery = sqlCalls().find((s) => s.includes("ma.type = 'relation'"));
        expect(relationQuery).toContain('t.scope_id = e.scope_id');
      });

      it("refuses to delete a scope's index entry", async () => {
        twoScopes();
        const base = makeDbRouter(passwordHash);
        mockExecute.mockImplementation(async (input: any) => {
          const sql = typeof input === 'string' ? input : input.sql;
          if (sql.includes('FROM memory_scopes WHERE root_entry_id = ?')) {
            return { rows: [{ id: SCOPE_ID }], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
          }
          return base(input);
        });

        const res = await app.inject({
          method: 'DELETE', url: `/api/memory/entries/${ROOT_ID}`, headers: { cookie: sessionCookie },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('CANNOT_DELETE_ROOT');
      });
    });

    describe('scope CRUD', () => {
      it('refuses a slug that near-duplicates an existing scope', async () => {
        // An agent quietly splitting a vault into "acme" and "acme-corp" is the
        // failure mode worth blocking; neither it nor the user will reconcile it.
        twoScopes();
        const base = makeDbRouter(passwordHash);
        mockExecute.mockImplementation(async (input: any) => {
          const sql = typeof input === 'string' ? input : input.sql;
          if (sql.includes('similarity(slug')) {
            return { rows: [{ slug: 'work' }], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
          }
          if (sql.includes('FROM memory_scopes WHERE root_entry_id = ?')) return { rows: [], columns: [], rowsAffected: 0, lastInsertRowid: 0n };
          if (sql.includes('FROM memory_scopes')) {
            return {
              rows: [scopeRow, { ...scopeRow, id: 'scope-work-id', slug: 'work', is_default: false }],
              columns: [], rowsAffected: 2, lastInsertRowid: 0n,
            };
          }
          return base(input);
        });

        const res = await app.inject({
          method: 'POST', url: '/api/memory/scopes', headers: { cookie: sessionCookie },
          payload: { name: 'Work Stuff', slug: 'works' },
        });

        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('SIMILAR_SCOPE');
      });

      it('rejects a reserved slug', async () => {
        twoScopes();

        const res = await app.inject({
          method: 'POST', url: '/api/memory/scopes', headers: { cookie: sessionCookie },
          payload: { name: 'All' },
        });

        expect(res.statusCode).toBe(400);
      });

      it('refuses to delete the default scope', async () => {
        twoScopes();

        const res = await app.inject({
          method: 'DELETE', url: `/api/memory/scopes/${SCOPE_ID}`, headers: { cookie: sessionCookie },
        });

        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('CANNOT_DELETE_DEFAULT');
      });
    });
  });
});
