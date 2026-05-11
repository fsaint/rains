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

    // ── Memory root check (ensureMemoryRoot + GET /api/memory/root) ───────────
    if (sql.includes("type = 'index'") && sql.includes('FROM memory_entries')) {
      return { rows: [rootRow], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
    }

    // Fetch root by id after ensureMemoryRoot returns the id
    if (sql.startsWith('SELECT id, type, title, content') && sql.includes('FROM memory_entries WHERE id = ?')) {
      return { rows: [rootRow], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
    }

    // ── Entry ownership check (used by PUT, POST attributes, DELETE entry) ────
    if (sql.startsWith('SELECT id FROM memory_entries WHERE id = ?')) {
      return { rows: [{ id: ENTRY_ID }], columns: [], rowsAffected: 1, lastInsertRowid: 0n };
    }

    // ── Full entry fetch with all fields (GET /api/memory/entries/:id body) ───
    if (sql.startsWith('SELECT id, user_id, type, title, content') && sql.includes('FROM memory_entries WHERE id = ?')) {
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
      // Override: root lookup returns empty → triggers creation path
      const createSequence: Array<Record<string, unknown>[]> = [
        [],          // SELECT type='index' → empty → will create
        [],          // INSERT memory_entries
        [],          // INSERT memory_branches
        [rootRow],   // SELECT by id after creation
      ];
      let idx = 0;
      mockExecute.mockImplementation(async () => ({
        rows: createSequence[idx++] ?? [],
        columns: [], rowsAffected: 0, lastInsertRowid: 0n,
      }));

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
      mockExecute.mockImplementationOnce(async () => EMPTY);

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
      mockExecute.mockImplementationOnce(async () => EMPTY);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/memory/entries/other-users-entry',
        headers: { cookie: sessionCookie },
        payload: { title: 'Hacked' },
      });

      expect(res.statusCode).toBe(404);
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
      mockExecute.mockImplementationOnce(async () => EMPTY);

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
      mockExecute.mockImplementationOnce(async () => EMPTY);

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
});
