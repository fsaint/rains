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


/**
 * Routing for a graph where `closedIds` sit under the closed-thread root e-root
 * and `e-root` itself is that root. Every id in `reachable` passes the scope check.
 */
function closedGraph(closedIds: string[], extra: Array<[RegExp, unknown]> = []) {
  mockExecute.mockImplementation((q: any) => {
    const args: unknown[] = q.args ?? [];
    for (const [pattern, result] of extra) {
      if (pattern.test(q.sql)) return Promise.resolve(result);
    }
    if (/FROM threads WHERE root_entry_id = \?/.test(q.sql)) {
      return Promise.resolve(args[0] === 'e-root' ? rows([{ id: 'th-1', status: 'closed' }]) : empty);
    }
    if (/FROM memory_branches WHERE entry_id = \?/.test(q.sql)) {
      return Promise.resolve(closedIds.includes(args[0] as string) ? rows([{ parent_entry_id: 'e-root' }]) : empty);
    }
    return Promise.resolve(empty);
  });
}

const reachableEntry = (id: string) =>
  [/FROM memory_entries\s+WHERE id = \? AND scope_id IN/, rows([{ id, scope_id: 'scope-1', type: 'note', title: 't', content: 'c', version: 1 }])] as [RegExp, unknown];

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

    it('with an open thread and reassign_to → still 409 SCOPE_HAS_THREADS', async () => {
      routeDb([scopeRow, [/FROM threads WHERE scope_id = \?/, rows([{ '?column?': 1 }])]]);
      const res = await app.inject({ method: 'DELETE', url: '/api/memory/scopes/scope-2?reassign_to=scope-1' });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('SCOPE_HAS_THREADS');
    });

    it('with closed threads and reassign_to → threads move with their entries before the scope goes', async () => {
      routeDb([
        scopeRow,
        [/FROM memory_scopes WHERE id = \? AND user_id = \?/, rows([{ id: 'scope-2', slug: 'p', name: 'P', is_system: false }])],
        [/COUNT\(\*\) AS count/, rows([{ count: 3 }])],
      ]);
      const res = await app.inject({ method: 'DELETE', url: '/api/memory/scopes/scope-2?reassign_to=scope-1' });
      expect(res.statusCode).toBe(200);
      const calls = mockExecute.mock.calls.map((c) => c[0] as { sql: string; args: unknown[] });
      const moveIdx = calls.findIndex((c) => /UPDATE threads SET scope_id = \?/.test(c.sql));
      const deleteIdx = calls.findIndex((c) => /DELETE FROM memory_scopes/.test(c.sql));
      expect(moveIdx).toBeGreaterThan(-1);
      expect(moveIdx).toBeLessThan(deleteIdx);
      expect(calls[moveIdx].args).toContain('scope-1');
      expect(calls[moveIdx].args).toContain('scope-2');
    });

    it('archive=true with an active or paused thread → 409 SCOPE_HAS_THREADS, nothing archived', async () => {
      routeDb([scopeRow, [/FROM threads WHERE scope_id = \?/, rows([{ '?column?': 1 }])]]);
      const res = await app.inject({ method: 'DELETE', url: '/api/memory/scopes/scope-2?archive=true' });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('SCOPE_HAS_THREADS');
      expect(mockExecute.mock.calls.some((c) => /UPDATE memory_scopes/.test(c[0].sql))).toBe(false);
    });

    it('archive=true with only closed threads → archived', async () => {
      routeDb([scopeRow, [/FROM threads WHERE scope_id = \?/, empty]]);
      const res = await app.inject({ method: 'DELETE', url: '/api/memory/scopes/scope-2?archive=true' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ archived: true });
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


  describe('PUT /api/memory/scopes/:id archived', () => {
    const scopeRow = [/FROM memory_scopes WHERE id = \? AND user_id = \?/, rows([{ id: 'scope-2', slug: 'p', name: 'P', is_system: false }])] as [RegExp, unknown];

    it('archived: true with an active or paused thread → 409 SCOPE_HAS_THREADS, nothing written', async () => {
      routeDb([scopeRow, [/FROM threads WHERE scope_id = \?/, rows([{ '?column?': 1 }])]]);
      const res = await app.inject({ method: 'PUT', url: '/api/memory/scopes/scope-2', payload: { archived: true, name: 'Renamed' } });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('SCOPE_HAS_THREADS');
      expect(mockExecute.mock.calls.some((c) => /UPDATE memory_scopes/.test(c[0].sql))).toBe(false);
    });

    it('archived: false (unarchive) is not refused', async () => {
      routeDb([scopeRow, [/FROM threads WHERE scope_id = \?/, rows([{ '?column?': 1 }])]]);
      const res = await app.inject({ method: 'PUT', url: '/api/memory/scopes/scope-2', payload: { archived: false } });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('closed threads are read-only through every memory write route', () => {
    it('PUT /scope moving a child of a closed thread to another scope → 409 THREAD_CLOSED, nothing moved', async () => {
      closedGraph(['e-1'], [[/SELECT id, scope_id FROM memory_entries/, rows([{ id: 'e-1', scope_id: 'scope-2' }])]]);
      const res = await app.inject({ method: 'PUT', url: '/api/memory/entries/e-1/scope', payload: { scope: 'work' } });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('THREAD_CLOSED');
      expect(mockExecute.mock.calls.some((c) => /^\s*(UPDATE|DELETE)/.test(c[0].sql))).toBe(false);
    });

    it('DELETE of a child of a closed thread → 409 THREAD_CLOSED', async () => {
      closedGraph(['e-1'], [reachableEntry('e-1')]);
      const res = await app.inject({ method: 'DELETE', url: '/api/memory/entries/e-1' });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('THREAD_CLOSED');
    });

    it('POST with a parent_id inside a closed thread → 409 THREAD_CLOSED', async () => {
      closedGraph(['e-1'], [[/SELECT scope_id FROM memory_entries WHERE id = \?/, rows([{ scope_id: 'scope-1' }])]]);
      const res = await app.inject({
        method: 'POST', url: '/api/memory/entries', payload: { title: 'Note', parent_id: 'e-root' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('THREAD_CLOSED');
    });

    it('PUT /parent moving an entry out of a closed thread → 409 THREAD_CLOSED', async () => {
      closedGraph(['e-1'], [reachableEntry('e-1')]);
      const res = await app.inject({ method: 'PUT', url: '/api/memory/entries/e-1/parent', payload: { parent_id: null } });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('THREAD_CLOSED');
    });

    it('PUT /parent moving an entry into a closed thread → 409 THREAD_CLOSED', async () => {
      closedGraph([], [reachableEntry('e-2')]);
      const res = await app.inject({ method: 'PUT', url: '/api/memory/entries/e-2/parent', payload: { parent_id: 'e-root' } });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('THREAD_CLOSED');
    });

    it('PUT /parent on a thread root of any status → 400 THREAD_ROOT_PROTECTED', async () => {
      routeDb([reachableEntry('e-1'), rootOf('active')]);
      const res = await app.inject({ method: 'PUT', url: '/api/memory/entries/e-1/parent', payload: { parent_id: null } });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('THREAD_ROOT_PROTECTED');
    });

    it('PUT /parent on an unreachable thread root still reads as 404', async () => {
      routeDb([rootOf('active')]);
      const res = await app.inject({ method: 'PUT', url: '/api/memory/entries/e-1/parent', payload: { parent_id: null } });
      expect(res.statusCode).toBe(404);
    });

    it('POST attributes on an entry of a closed thread → 409 THREAD_CLOSED', async () => {
      closedGraph(['e-1'], [reachableEntry('e-1')]);
      const res = await app.inject({
        method: 'POST', url: '/api/memory/entries/e-1/attributes', payload: { type: 'label', name: 'a', value: 'b' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('THREAD_CLOSED');
    });

    it('DELETE attribute on an entry of a closed thread → 409 THREAD_CLOSED', async () => {
      closedGraph(['e-1'], [[/FROM memory_attributes ma/, rows([{ id: 'at-1', entry_id: 'e-1' }])]]);
      const res = await app.inject({ method: 'DELETE', url: '/api/memory/attributes/at-1' });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('THREAD_CLOSED');
    });
  });

  it('PUT /scope on an unreachable thread root still reads as 404', async () => {
    routeDb([rootOf('active')]);
    const res = await app.inject({ method: 'PUT', url: '/api/memory/entries/e-1/scope', payload: { scope: 'work' } });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/memory/dream omits thread entries', async () => {
    routeDb([[/FROM memory_entries e/, empty]]);
    const res = await app.inject({ method: 'GET', url: '/api/memory/dream' });
    expect(res.statusCode).toBe(200);
    const sql = mockExecute.mock.calls.map((c) => c[0].sql as string).find((q) => /FROM memory_entries e/.test(q));
    expect(sql).toContain("e.type <> 'thread'");
  });
});
