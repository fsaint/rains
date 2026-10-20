/**
 * Thread guards on the memory routes: a thread's root cannot be deleted or
 * moved, a closed thread's entries are read-only, the `thread` type is
 * reserved, and a scope holding live threads cannot be deleted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

const {
  mockExecute,
  mockGetSession,
  mockRequireAdmin,
  mockResolveMemoryContext,
} = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockGetSession: vi.fn(),
  mockRequireAdmin: vi.fn(),
  mockResolveMemoryContext: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  client: { execute: mockExecute },
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

vi.mock('../auth/index.js', () => ({
  getSession: mockGetSession,
  requireAdmin: mockRequireAdmin,
  createMagicLinkToken: vi.fn(),
  verifyMagicLinkToken: vi.fn(),
}));

// The route module reads validServiceTypes from this registry at startup.
vi.mock('@reins/servers', () => ({
  serviceDefinitions: [
    { type: 'gmail', name: 'Gmail' },
    { type: 'calendar', name: 'Calendar' },
    { type: 'skills', name: 'Skills' },
  ],
}));

vi.mock('../approvals/queue.js', () => ({
  MAX_REVISIONS: 3,
  approvalQueue: {
    requestChanges: vi.fn(), approve: vi.fn(), reject: vi.fn(), get: vi.fn(),
    submit: vi.fn(), listPending: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('../audit/logger.js', () => ({
  auditLogger: {
    log: vi.fn().mockResolvedValue(1),
    logApproval: vi.fn().mockResolvedValue(1),
    logToolCall: vi.fn().mockResolvedValue(1),
    logAgentEvent: vi.fn().mockResolvedValue(1),
    query: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('../config/index.js', () => ({
  config: {
    dashboardUrl: 'http://localhost:5173',
    publicUrl: 'http://localhost:3000',
    nodeEnv: 'test',
    encryptionKey: '0'.repeat(64),
  },
}));
vi.mock('../policy/engine.js', () => ({ policyEngine: {} }));
vi.mock('../credentials/vault.js', () => ({ credentialVault: {} }));
vi.mock('../mcp/proxy.js', () => ({ mcpProxy: {} }));
vi.mock('../mcp/server-manager.js', () => ({ serverManager: {} }));
vi.mock('../notifications/apns.js', () => ({ apnsService: {} }));
vi.mock('../notifications/telegram.js', () => ({ telegramNotifier: {} }));
vi.mock('../mcp/agent-endpoint.js', () => ({ handleMCPRequest: vi.fn() }));
vi.mock('../analytics/posthog.js', () => ({ getPostHog: () => null }));
vi.mock('../services/email.js', () => ({ sendReauthEmail: vi.fn() }));
vi.mock('../services/agent-uploads.js', () => ({
  createUpload: vi.fn(), getUpload: vi.fn(), MAX_UPLOAD_BYTES: 1024,
}));
// Real memory service: the dream manifest's SQL is itself under test.
vi.mock('../services/memory-scopes.js', async () => {
  const actual = await vi.importActual<typeof import('../services/memory-scopes.js')>('../services/memory-scopes.js');
  return { ...actual, resolveMemoryContext: mockResolveMemoryContext };
});

import { apiRoutes } from './routes.js';

const empty = { rows: [], rowsAffected: 0, columns: [] };
const rows = (r: Record<string, unknown>[]) => ({ rows: r, rowsAffected: r.length, columns: [] });

const memCtx = {
  userId: 'user-1', agentId: null, isSession: true,
  scopes: [{ id: 'scope-1', slug: 'work', name: 'Work', isDefault: true }],
  scopeIds: ['scope-1', 'scope-2'], defaultScopeId: 'scope-1',
};

/** Route the single db mock by inspecting the SQL, so each test states only the rows that matter. */
function routeDb(handlers: Array<[RegExp, unknown]>) {
  mockExecute.mockImplementation((q: any) => {
    const text: string = typeof q === 'string' ? q : q.sql;
    for (const [pattern, result] of handlers) {
      if (pattern.test(text)) return Promise.resolve(result);
    }
    return Promise.resolve(empty);
  });
}

const entryRow = (over: Record<string, unknown> = {}) =>
  rows([{ id: 'e-1', type: 'note', scope_id: 'scope-1', title: 'T', content: 'c', version: 1, ...over }]);

/** Entry e-1 is the root of a thread with the given status. */
const rootOf = (status: string) => [/FROM threads WHERE root_entry_id = \?/, rows([{ id: 'th-1', status }])] as [RegExp, unknown];

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  app.addHook('onRequest', async (request: any) => {
    request.session = mockGetSession();
  });
  await app.register(apiRoutes);
  await app.ready();
  await new Promise((r) => setTimeout(r, 0));
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  mockGetSession.mockReturnValue({ userId: 'user-1', email: 'me@example.com', role: 'user' });
  mockRequireAdmin.mockReturnValue(true);
  mockResolveMemoryContext.mockResolvedValue(memCtx);
  mockExecute.mockResolvedValue(empty);
  app = await buildApp();
});

describe('memory routes — thread guards', () => {
  it('POST /api/memory/entries with type "thread" → 400 THREAD_TYPE_RESERVED', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/memory/entries', payload: { title: 'Sneaky', type: 'thread' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('THREAD_TYPE_RESERVED');
  });

  it('PUT changing type to "thread" → 400 THREAD_TYPE_RESERVED', async () => {
    routeDb([[/FROM memory_entries\s+WHERE id = \? AND scope_id IN/, entryRow()]]);
    const res = await app.inject({ method: 'PUT', url: '/api/memory/entries/e-1', payload: { type: 'thread' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('THREAD_TYPE_RESERVED');
  });

  it('PUT changing type away from "thread" → 400 THREAD_TYPE_RESERVED', async () => {
    routeDb([[/FROM memory_entries\s+WHERE id = \? AND scope_id IN/, entryRow({ type: 'thread' })]]);
    const res = await app.inject({ method: 'PUT', url: '/api/memory/entries/e-1', payload: { type: 'note' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('THREAD_TYPE_RESERVED');
  });

  it('DELETE on a thread root → 400 THREAD_ROOT_PROTECTED', async () => {
    routeDb([
      [/FROM memory_entries WHERE id = \? AND scope_id IN/, rows([{ id: 'e-1' }])],
      rootOf('active'),
    ]);
    const res = await app.inject({ method: 'DELETE', url: '/api/memory/entries/e-1' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('THREAD_ROOT_PROTECTED');
  });

  it('DELETE on a thread root the caller cannot reach still reads as 404', async () => {
    routeDb([rootOf('active')]);
    const res = await app.inject({ method: 'DELETE', url: '/api/memory/entries/e-1' });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /scope on a thread root → 400 THREAD_ROOT_PROTECTED', async () => {
    routeDb([
      [/SELECT id, scope_id FROM memory_entries/, rows([{ id: 'e-1', scope_id: 'scope-2' }])],
      rootOf('active'),
    ]);
    const res = await app.inject({ method: 'PUT', url: '/api/memory/entries/e-1/scope', payload: { scope: 'work' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('THREAD_ROOT_PROTECTED');
  });

  it('PUT content on a closed thread root → 409 THREAD_CLOSED', async () => {
    routeDb([[/FROM memory_entries\s+WHERE id = \? AND scope_id IN/, entryRow({ type: 'thread' })], rootOf('closed')]);
    const res = await app.inject({ method: 'PUT', url: '/api/memory/entries/e-1', payload: { content: 'x' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('THREAD_CLOSED');
  });

  it('PUT content on a child of a closed thread root → 409 THREAD_CLOSED', async () => {
    mockExecute.mockImplementation((q: any) => {
      const args: unknown[] = q.args ?? [];
      if (/FROM memory_entries\s+WHERE id = \? AND scope_id IN/.test(q.sql)) return Promise.resolve(entryRow());
      if (/FROM threads WHERE root_entry_id = \?/.test(q.sql)) {
        return Promise.resolve(args[0] === 'e-root' ? rows([{ id: 'th-1', status: 'closed' }]) : empty);
      }
      if (/FROM memory_branches WHERE entry_id = \?/.test(q.sql)) {
        return Promise.resolve(args[0] === 'e-1' ? rows([{ parent_entry_id: 'e-root' }]) : empty);
      }
      return Promise.resolve(empty);
    });
    const res = await app.inject({ method: 'PUT', url: '/api/memory/entries/e-1', payload: { content: 'x' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('THREAD_CLOSED');
  });

  it('PUT content on an active thread root → 200', async () => {
    routeDb([
      [/FROM memory_entries\s+WHERE id = \? AND scope_id IN/, entryRow({ type: 'thread' })],
      rootOf('active'),
      [/UPDATE memory_entries/, { rows: [], rowsAffected: 1, columns: [] }],
      [/SELECT id, user_id, type/, entryRow({ type: 'thread', content: 'x', version: 2 })],
    ]);
    const res = await app.inject({ method: 'PUT', url: '/api/memory/entries/e-1', payload: { content: 'x' } });
    expect(res.statusCode).toBe(200);
  });

  describe('DELETE /api/memory/scopes/:id', () => {
    const scopeRow = [/FROM memory_scopes WHERE id = \? AND user_id = \?/, rows([{ id: 'scope-2', slug: 'p', name: 'P', is_system: false }])] as [RegExp, unknown];

    it('with an active or paused thread → 409 SCOPE_HAS_THREADS', async () => {
      routeDb([scopeRow, [/FROM threads WHERE scope_id = \?/, rows([{ '?column?': 1 }])]]);
      const res = await app.inject({ method: 'DELETE', url: '/api/memory/scopes/scope-2' });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('SCOPE_HAS_THREADS');
    });

    it('allows deleting a scope whose threads are all closed', async () => {
      routeDb([scopeRow, [/FROM threads WHERE scope_id = \?/, empty], [/COUNT\(\*\) AS count/, rows([{ count: 0 }])]]);
      const res = await app.inject({ method: 'DELETE', url: '/api/memory/scopes/scope-2' });
      expect(res.statusCode).toBe(200);
      const sqls = mockExecute.mock.calls.map((c) => c[0].sql as string);
      expect(sqls.find((q) => /FROM threads WHERE scope_id/.test(q))).toContain("status <> 'closed'");
      expect(sqls.some((q) => /DELETE FROM memory_scopes/.test(q))).toBe(true);
    });
  });

  it('GET /api/memory/dream omits thread entries', async () => {
    routeDb([[/FROM memory_entries e/, empty]]);
    const res = await app.inject({ method: 'GET', url: '/api/memory/dream' });
    expect(res.statusCode).toBe(200);
    const sql = mockExecute.mock.calls.map((c) => c[0].sql as string).find((q) => /FROM memory_entries e/.test(q));
    expect(sql).toContain("e.type <> 'thread'");
  });
});
