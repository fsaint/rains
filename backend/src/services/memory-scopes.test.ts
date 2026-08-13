/**
 * Memory scope resolution tests.
 *
 * The properties here are the ones a reimplementation would get wrong, and one
 * of them — an agent with no grants seeing every scope — is the entire
 * backward-compatibility guarantee of the feature. If that inverts, every
 * already-deployed agent silently loses its memory on the deploy that ships it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  client: { execute: vi.fn() },
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

vi.mock('nanoid', () => ({ nanoid: vi.fn(() => 'generated-id') }));

import { client } from '../db/index.js';
import {
  ensureDefaultScope,
  listUserScopes,
  getAgentScopeGrants,
  setAgentScopeGrants,
  resolveMemoryContext,
  pickScope,
  isRejection,
  type MemoryContext,
} from './memory-scopes.js';

const USER = 'user-1';
const AGENT = 'agent-1';

const rows = (r: Record<string, unknown>[]) => ({ rows: r, rowsAffected: r.length, columns: [] });
const EMPTY = rows([]);

function scopeRow(over: Record<string, unknown> = {}) {
  return {
    id: 'scope-default', slug: 'default', name: 'Default',
    description: null, is_default: true, archived_at: null, ...over,
  };
}

/** Feed queued results to client.execute in call order. */
function queue(...results: unknown[]) {
  const mock = vi.mocked(client.execute);
  mock.mockReset();
  for (const r of results) mock.mockResolvedValueOnce(r as never);
  mock.mockResolvedValue(EMPTY as never);
}

/** The SQL of the nth call. */
const sqlAt = (n: number) => (vi.mocked(client.execute).mock.calls[n][0] as { sql: string }).sql;
const argsAt = (n: number) => (vi.mocked(client.execute).mock.calls[n][0] as { args: unknown[] }).args;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ensureDefaultScope', () => {
  it('returns the existing default without inserting', async () => {
    queue(rows([scopeRow()]));

    const scope = await ensureDefaultScope(USER);

    expect(scope.slug).toBe('default');
    expect(vi.mocked(client.execute)).toHaveBeenCalledTimes(1);
  });

  it('creates one when the user has none, deriving the same id as the backfill', async () => {
    queue(EMPTY, EMPTY, rows([scopeRow()]));

    const scope = await ensureDefaultScope(USER);

    expect(scope.id).toBe('scope-default');
    // md5('memscope:' || user_id) — matches the boot backfill so a concurrent
    // start cannot race a second row in.
    expect(argsAt(1)[0]).toBe(`memscope:${USER}`);
    expect(sqlAt(1)).toContain('ON CONFLICT (user_id, slug) DO NOTHING');
  });
});

describe('listUserScopes', () => {
  it('excludes archived scopes by default', async () => {
    queue(rows([scopeRow()]));

    await listUserScopes(USER);

    expect(sqlAt(0)).toContain('archived_at IS NULL');
  });

  it('includes them when asked', async () => {
    queue(rows([scopeRow()]));

    await listUserScopes(USER, { includeArchived: true });

    expect(sqlAt(0)).not.toContain('archived_at IS NULL');
  });
});

describe('getAgentScopeGrants', () => {
  it('gives an agent with no grant rows every scope its owner has', async () => {
    // THE backward-compatibility guarantee. Grants narrow; they do not enable.
    queue(rows([
      { ...scopeRow(), granted: false, grant_count: 0 },
      { ...scopeRow({ id: 'scope-work', slug: 'work', name: 'Work', is_default: false }), granted: false, grant_count: 0 },
    ]));

    const grants = await getAgentScopeGrants(AGENT, USER);

    expect(grants.mode).toBe('all');
    expect(grants.scopes.map((s) => s.slug)).toEqual(['default', 'work']);
    expect(grants.defaultScopeId).toBe('scope-default');
  });

  it('restricts to exactly the granted scopes once any grant exists', async () => {
    queue(rows([
      { ...scopeRow(), granted: false, grant_count: 1 },
      { ...scopeRow({ id: 'scope-work', slug: 'work', name: 'Work', is_default: true }), granted: true, grant_count: 1 },
    ]));

    const grants = await getAgentScopeGrants(AGENT, USER);

    expect(grants.mode).toBe('restricted');
    expect(grants.scopes.map((s) => s.slug)).toEqual(['work']);
  });

  it("lets a grant's default override the user-level default", async () => {
    queue(rows([
      { ...scopeRow({ id: 'scope-work', slug: 'work', name: 'Work', is_default: true }), granted: true, grant_count: 2 },
      { ...scopeRow({ is_default: false }), granted: true, grant_count: 2 },
    ]));

    const grants = await getAgentScopeGrants(AGENT, USER);

    expect(grants.defaultScopeId).toBe('scope-work');
  });

  it("scopes the lookup to the owner, so a grant to another user's scope is inert", async () => {
    queue(EMPTY);

    await getAgentScopeGrants(AGENT, USER);

    expect(sqlAt(0)).toContain('s.user_id = ?');
    expect(argsAt(0)).toContain(USER);
  });
});

describe('setAgentScopeGrants', () => {
  it('clears every grant when passed null, restoring implicit access', async () => {
    queue(EMPTY);

    await setAgentScopeGrants(AGENT, USER, null);

    expect(sqlAt(0)).toContain('DELETE FROM agent_memory_scopes');
    expect(vi.mocked(client.execute)).toHaveBeenCalledTimes(1);
  });

  it("refuses to write a grant for a scope the user does not own", async () => {
    queue(EMPTY, rows([{ id: 'scope-work' }]));

    await setAgentScopeGrants(AGENT, USER, {
      scopeIds: ['scope-work', 'someone-elses-scope'],
      defaultScopeId: 'scope-work',
    });

    const inserts = vi.mocked(client.execute).mock.calls
      .map((c) => c[0] as { sql: string; args: unknown[] })
      .filter((q) => q.sql.includes('INSERT INTO agent_memory_scopes'));

    expect(inserts).toHaveLength(1);
    expect(inserts[0].args).toContain('scope-work');
  });

  it('flags exactly the requested default', async () => {
    queue(EMPTY, rows([{ id: 'scope-default' }, { id: 'scope-work' }]));

    await setAgentScopeGrants(AGENT, USER, {
      scopeIds: ['scope-default', 'scope-work'],
      defaultScopeId: 'scope-work',
    });

    const inserts = vi.mocked(client.execute).mock.calls
      .map((c) => c[0] as { sql: string; args: unknown[] })
      .filter((q) => q.sql.includes('INSERT INTO agent_memory_scopes'));

    expect(inserts.find((i) => i.args.includes('scope-default'))!.args).toContain(false);
    expect(inserts.find((i) => i.args.includes('scope-work'))!.args).toContain(true);
  });
});

describe('resolveMemoryContext', () => {
  const noAgent = async () => null;

  it('gives a session every one of the user\'s scopes', async () => {
    queue(rows([scopeRow(), scopeRow({ id: 'scope-work', slug: 'work', is_default: false })]));

    const ctx = await resolveMemoryContext({ userId: USER }, noAgent);

    expect(ctx!.isSession).toBe(true);
    expect(ctx!.agentId).toBeNull();
    expect(ctx!.scopeIds).toEqual(['scope-default', 'scope-work']);
    expect(ctx!.defaultScopeId).toBe('scope-default');
  });

  it('creates a default scope for a user who has never written anything', async () => {
    // The boot backfill only covers users who already had entries.
    queue(EMPTY, rows([scopeRow()]));

    const ctx = await resolveMemoryContext({ userId: USER }, noAgent);

    expect(ctx!.defaultScopeId).toBe('scope-default');
  });

  it('keeps the agent identity for a gateway-token caller', async () => {
    queue(rows([{ ...scopeRow(), granted: false, grant_count: 0 }]));

    const ctx = await resolveMemoryContext(null, async () => ({ agentId: AGENT, userId: USER }));

    expect(ctx!.agentId).toBe(AGENT);
    expect(ctx!.isSession).toBe(false);
    expect(ctx!.userId).toBe(USER);
  });

  it('returns null when neither auth mode yields a user', async () => {
    expect(await resolveMemoryContext(null, noAgent)).toBeNull();
  });
});

describe('pickScope', () => {
  const ctx: MemoryContext = {
    userId: USER,
    agentId: AGENT,
    scopes: [
      { id: 'scope-default', slug: 'default', name: 'Default', description: null, isDefault: true, archivedAt: null },
      { id: 'scope-work', slug: 'work', name: 'Work', description: null, isDefault: false, archivedAt: null },
    ],
    scopeIds: ['scope-default', 'scope-work'],
    defaultScopeId: 'scope-default',
    isSession: false,
  };

  it('spans every reachable scope for a read with no scope given', () => {
    const r = pickScope(ctx, undefined, 'read');
    expect(isRejection(r)).toBe(false);
    expect((r as { scopeIds: string[] }).scopeIds).toEqual(['scope-default', 'scope-work']);
  });

  it('targets only the default for a write with no scope given', () => {
    const r = pickScope(ctx, undefined, 'write');
    expect((r as { scopeIds: string[] }).scopeIds).toEqual(['scope-default']);
  });

  it('matches a slug, case-insensitively', () => {
    expect((pickScope(ctx, 'WORK', 'read') as { scopeIds: string[] }).scopeIds).toEqual(['scope-work']);
  });

  it('matches an id, for the dashboard', () => {
    expect((pickScope(ctx, 'scope-work', 'read') as { scopeIds: string[] }).scopeIds).toEqual(['scope-work']);
  });

  it('rejects an ungranted scope with 403 and the list of usable slugs', () => {
    // The list is the point: a model that gets it back can correct itself on the
    // next call instead of failing the task.
    const r = pickScope(ctx, 'finance', 'read');

    expect(isRejection(r)).toBe(true);
    const rej = r as { status: number; body: Record<string, unknown> };
    expect(rej.status).toBe(403);
    expect(rej.body.code).toBe('SCOPE_NOT_GRANTED');
    expect(rej.body.available_scopes).toEqual(['default', 'work']);
    expect(rej.body.error).toContain('finance');
  });

  it('rejects an empty scope as a bad request, not a permission failure', () => {
    const r = pickScope(ctx, '   ', 'read');
    expect((r as { status: number }).status).toBe(400);
  });
});
