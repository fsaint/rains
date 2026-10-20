/**
 * Thread Watcher Tests
 *
 * A watcher is bounded by its creating agent's own access: these pin the
 * refusals (no service, an account the agent does not hold, a tool that is not
 * `allow`, a project other than the pinned one) and the plain-words text the
 * approval message shows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  client: {
    execute: vi.fn().mockResolvedValue({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] }),
  },
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'w-id'),
}));

vi.mock('../mcp/agent-endpoint.js', () => ({
  resolveToolPolicy: vi.fn(),
  runAgentReadTool: vi.fn(),
}));

vi.mock('./permissions.js', () => ({
  getInstanceConfig: vi.fn(),
}));

import { client } from '../db/index.js';
import { resolveToolPolicy, runAgentReadTool } from '../mcp/agent-endpoint.js';
import { getInstanceConfig } from './permissions.js';
import { checkWatcherAccess, addWatcher, removeWatcher, describeWatcher, runWatcherSweep } from './thread-watchers.js';

const gmailInst = { id: 'inst-g', agentId: 'a1', serviceType: 'gmail', enabled: true, isDefault: true, credentialId: 'cred-g' };
const hxInst = { id: 'inst-h', agentId: 'a1', serviceType: 'hermeneutix', enabled: true, isDefault: true, credentialId: 'cred-h' };

const policy = (over: Record<string, unknown> = {}) => ({
  allowed: true,
  requiresApproval: false,
  hasInstances: true,
  serviceInstances: [gmailInst],
  policyInstance: gmailInst,
  ...over,
});

const notEnabled = { error: { code: -32003, message: 'Service not enabled for this agent: gmail', data: {} } };
const noAccount = { error: { code: -32001, message: 'No credential found for account: z@y.com.', data: {} } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkWatcherAccess', () => {
  it('refuses a gmail watcher when the agent has no gmail service → WATCHER_SOURCE_NOT_GRANTED message', async () => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(notEnabled as never);

    const res = await checkWatcherAccess('a1', { kind: 'gmail_sender', value: 'bob@x.com' });

    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toMatch(/^WATCHER_SOURCE_NOT_GRANTED/);
    expect(!res.ok && res.message).toContain('Gmail');
    expect(resolveToolPolicy).toHaveBeenCalledWith('a1', 'gmail', 'gmail_search', {});
  });

  it('refuses a gmail watcher for an account the agent does not hold', async () => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(noAccount as never);

    const res = await checkWatcherAccess('a1', { kind: 'gmail_query', value: 'from:bob', account: 'z@y.com' });

    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toMatch(/^WATCHER_SOURCE_NOT_GRANTED/);
    expect(!res.ok && res.message).toContain('z@y.com');
    expect(resolveToolPolicy).toHaveBeenCalledWith('a1', 'gmail', 'gmail_search', { account: 'z@y.com' });
  });

  it('refuses a named account when the agent has gmail only through the legacy access row', async () => {
    // The legacy path cannot resolve an account, so it must not be read as "holds it".
    vi.mocked(resolveToolPolicy).mockResolvedValue(
      policy({ hasInstances: false, serviceInstances: [], policyInstance: undefined }) as never
    );

    const res = await checkWatcherAccess('a1', { kind: 'gmail_sender', value: 'bob@x.com', account: 'ana@y.com' });

    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toContain('ana@y.com');
  });

  it.each([
    ['require_approval', { requiresApproval: true }],
    ['block', { allowed: false }],
  ])('refuses a gmail watcher when gmail_search is %s', async (_label, over) => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(policy(over) as never);

    const res = await checkWatcherAccess('a1', { kind: 'gmail_thread', value: 'th1' });

    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toMatch(/^WATCHER_SOURCE_NOT_GRANTED/);
    expect(!res.ok && res.message).toContain('gmail_search');
  });

  it('accepts a gmail_sender watcher when gmail_search is allow', async () => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(policy() as never);

    const res = await checkWatcherAccess('a1', { kind: 'gmail_sender', value: 'bob@x.com', account: 'ana@y.com' });

    expect(res).toEqual({ ok: true });
    expect(resolveToolPolicy).toHaveBeenCalledWith('a1', 'gmail', 'gmail_search', { account: 'ana@y.com' });
  });

  it('refuses an hx_project watcher for a project other than the pinned one', async () => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(
      policy({ serviceInstances: [hxInst], policyInstance: hxInst }) as never
    );
    vi.mocked(getInstanceConfig).mockResolvedValue({ config: { projectId: 'proj-pinned' } } as never);

    const res = await checkWatcherAccess('a1', { kind: 'hx_project', value: 'proj-other' });

    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toMatch(/^WATCHER_SOURCE_NOT_GRANTED/);
    expect(!res.ok && res.message).toContain('proj-other');
    expect(resolveToolPolicy).toHaveBeenCalledWith('a1', 'hermeneutix', 'hermeneutix_list_sessions', {});
    expect(getInstanceConfig).toHaveBeenCalledWith('inst-h');
  });

  it('accepts an hx_project watcher for the pinned project', async () => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(
      policy({ serviceInstances: [hxInst], policyInstance: hxInst }) as never
    );
    vi.mocked(getInstanceConfig).mockResolvedValue({ config: { projectId: 'proj-pinned' } } as never);

    expect(await checkWatcherAccess('a1', { kind: 'hx_project', value: 'proj-pinned' })).toEqual({ ok: true });
  });

  it.each([
    ['no config', null],
    ['no projectId', {}],
    ['empty projectId', { projectId: '' }],
    ['numeric projectId', { projectId: 42 }],
  ])('refuses hx watchers when no project is pinned (%s)', async (_label, config) => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(
      policy({ serviceInstances: [hxInst], policyInstance: hxInst }) as never
    );
    vi.mocked(getInstanceConfig).mockResolvedValue({ config } as never);

    for (const kind of ['hx_project', 'hx_meeting'] as const) {
      const res = await checkWatcherAccess('a1', { kind, value: 'x' });
      expect(res.ok).toBe(false);
      expect(!res.ok && res.message).toMatch(/pinned/);
    }
  });

  it('refuses hx watchers when hermeneutix is enabled only through the legacy access row', async () => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(
      policy({ hasInstances: false, serviceInstances: [], policyInstance: undefined }) as never
    );

    const res = await checkWatcherAccess('a1', { kind: 'hx_meeting', value: 'm-1' });

    expect(res.ok).toBe(false);
    expect(getInstanceConfig).not.toHaveBeenCalled();
  });

  it('accepts an hx_meeting watcher under any pin — the sweep fails closed outside it', async () => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(
      policy({ serviceInstances: [hxInst], policyInstance: hxInst }) as never
    );
    vi.mocked(getInstanceConfig).mockResolvedValue({ config: { projectId: 'proj-pinned' } } as never);

    expect(await checkWatcherAccess('a1', { kind: 'hx_meeting', value: 'meeting-9' })).toEqual({ ok: true });
  });

  it('refuses hx watchers when hermeneutix_list_sessions is not allow', async () => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(
      policy({ serviceInstances: [hxInst], policyInstance: hxInst, requiresApproval: true }) as never
    );
    vi.mocked(getInstanceConfig).mockResolvedValue({ config: { projectId: 'p' } } as never);

    const res = await checkWatcherAccess('a1', { kind: 'hx_project', value: 'p' });

    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toContain('hermeneutix_list_sessions');
  });

  it.each([
    ['an unknown kind', { kind: 'gmail_label', value: 'x' }],
    ['an empty value', { kind: 'gmail_sender', value: '  ' }],
    ['a non-string value', { kind: 'gmail_sender', value: 7 }],
    ['a non-string account', { kind: 'gmail_sender', value: 'x', account: 7 }],
  ])('refuses %s without resolving any policy', async (_label, w) => {
    const res = await checkWatcherAccess('a1', w as never);

    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toMatch(/^WATCHER_SOURCE_NOT_GRANTED/);
    expect(resolveToolPolicy).not.toHaveBeenCalled();
  });
});

describe('addWatcher', () => {
  it('inserts an active watcher row owned by the agent', async () => {
    const res = await addWatcher('t1', 'a1', { kind: 'gmail_query', value: 'from:bob', account: 'ana@y.com' });

    expect(res).toEqual({ id: 'w-id' });
    const call = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
    expect(call.sql).toContain('INSERT INTO thread_watchers');
    expect(call.sql).toContain("'active'");
    expect(call.args.slice(0, 6)).toEqual(['w-id', 't1', 'a1', 'gmail_query', 'from:bob', 'ana@y.com']);
    expect(typeof call.args[6]).toBe('string');
  });

  it('stores a missing account as null', async () => {
    await addWatcher('t1', 'a1', { kind: 'hx_project', value: 'p' });

    const call = vi.mocked(client.execute).mock.calls[0][0] as { args: unknown[] };
    expect(call.args[5]).toBeNull();
  });
});

describe('removeWatcher', () => {
  it('deletes only a watcher of the given thread', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({ rows: [{ id: 'w1' }] } as never);

    expect(await removeWatcher('t1', 'w1')).toBe(true);
    const call = vi.mocked(client.execute).mock.calls.at(-1)![0] as { sql: string; args: unknown[] };
    expect(call.sql).toContain('DELETE FROM thread_watchers WHERE id = ? AND thread_id = ?');
    expect(call.args).toEqual(['w1', 't1']);
  });

  it('returns false when that thread has no such watcher', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({ rows: [] } as never);
    expect(await removeWatcher('t1', 'w-other')).toBe(false);
  });
});

describe('describeWatcher', () => {
  it('describeWatcher names the account and query in plain words', () => {
    expect(describeWatcher({ kind: 'gmail_sender', value: 'bob@x.com', account: 'ana@y.com' }))
      .toBe('scan ana@y.com for mail from bob@x.com every 15 minutes');
  });

  it('falls back to the default Gmail account when none is named', () => {
    expect(describeWatcher({ kind: 'gmail_sender', value: 'bob@x.com' }))
      .toBe('scan the default Gmail account for mail from bob@x.com every 15 minutes');
  });

  it('describes the other kinds', () => {
    expect(describeWatcher({ kind: 'gmail_query', value: 'from:bob', account: 'ana@y.com' }))
      .toBe('scan ana@y.com for mail matching "from:bob" every 15 minutes');
    expect(describeWatcher({ kind: 'gmail_thread', value: 'th-1', account: null }))
      .toBe('scan the default Gmail account for new messages in Gmail thread th-1 every 15 minutes');
    expect(describeWatcher({ kind: 'hx_project', value: 'p-1' }))
      .toBe('scan Hermeneutix project p-1 for new sessions every 15 minutes');
    expect(describeWatcher({ kind: 'hx_meeting', value: 'm-1' }))
      .toBe('scan Hermeneutix meeting m-1 for new sessions every 15 minutes');
  });
});

describe('runWatcherSweep', () => {
  const NOW = new Date('2026-10-19T12:00:00.000Z');
  const CREATED = '2026-10-19T10:00:00.000Z';
  const watcherRow = (over: Record<string, unknown> = {}) => ({
    id: 'w1', thread_id: 't1', agent_id: 'a1', kind: 'gmail_sender', value: 'bob@x.com',
    account: null, last_checked_at: null, created_at: CREATED, ...over,
  });
  const sqlOf = (q: any): string => (typeof q === 'string' ? q : q.sql);
  const callsMatching = (frag: string) =>
    vi.mocked(client.execute).mock.calls.map((c: any) => c[0]).filter((q: any) => sqlOf(q).includes(frag));

  function wire(watchers: unknown[]) {
    vi.mocked(client.execute).mockImplementation((async (q: any) => {
      if (sqlOf(q).includes('FROM thread_watchers')) {
        return { rows: watchers, rowsAffected: watchers.length, columns: [] };
      }
      return { rows: [], rowsAffected: 1, columns: [] };
    }) as never);
  }

  const grantAccess = () =>
    vi.mocked(resolveToolPolicy).mockResolvedValue(policy() as never);
  const grantHxAccess = (projectId = 'p1') => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(
      policy({ serviceInstances: [hxInst], policyInstance: hxInst }) as never
    );
    vi.mocked(getInstanceConfig).mockResolvedValue({ config: { projectId } } as never);
  };

  const msg = (id: string, threadId = 'gt1') => ({ id, threadId, from: 'Bob <bob@x.com>', subject: `Subject ${id}` });

  it('selects only active watchers on active threads', async () => {
    wire([]);
    await runWatcherSweep(NOW);
    const sel = sqlOf(callsMatching('FROM thread_watchers')[0]);
    expect(sel).toContain("w.status = 'active'");
    expect(sel).toContain("t.status = 'active'");
  });

  it('inserts a candidate per new gmail match with source_ref gmail:<id>', async () => {
    wire([watcherRow()]);
    grantAccess();
    vi.mocked(runAgentReadTool).mockResolvedValue({ ok: true, data: { results: [msg('m1'), msg('m2')] } });

    const res = await runWatcherSweep(NOW);

    const since = Math.floor(new Date(CREATED).getTime() / 1000);
    expect(runAgentReadTool).toHaveBeenCalledWith('a1', 'gmail_search', {
      query: `from:"bob@x.com" after:${since}`,
      maxResults: 50,
    }, { watcherId: 'w1', threadId: 't1' });
    const inserts = callsMatching('INSERT INTO thread_candidates');
    expect(inserts).toHaveLength(2);
    expect(sqlOf(inserts[0])).toContain('ON CONFLICT (thread_id, source_ref) DO NOTHING');
    expect(inserts[0].args).toContain('gmail:m1');
    expect(inserts[0].args).toContain('gmail');
    expect(inserts[0].args).toContain('Bob <bob@x.com> — Subject m1');
    expect(res).toEqual({ checked: 1, found: 2, suspended: 0 });
  });

  it('passes the account and uses last_checked_at less a 15-minute lag margin as since for a gmail_query', async () => {
    wire([watcherRow({ kind: 'gmail_query', value: 'invoice', account: 'me@y.com', last_checked_at: '2026-10-19T11:00:00.000Z' })]);
    grantAccess();
    vi.mocked(runAgentReadTool).mockResolvedValue({ ok: true, data: { results: [] } });

    await runWatcherSweep(NOW);

    expect(runAgentReadTool).toHaveBeenCalledWith('a1', 'gmail_search', {
      query: `(invoice) after:${Math.floor(new Date('2026-10-19T10:45:00.000Z').getTime() / 1000)}`,
      maxResults: 50,
      account: 'me@y.com',
    }, { watcherId: 'w1', threadId: 't1' });
  });

  it('never reaches back before created_at with the lag margin', async () => {
    wire([watcherRow({ last_checked_at: '2026-10-19T10:05:00.000Z' })]);
    grantAccess();
    vi.mocked(runAgentReadTool).mockResolvedValue({ ok: true, data: { results: [] } });

    await runWatcherSweep(NOW);

    const since = Math.floor(new Date(CREATED).getTime() / 1000);
    expect(vi.mocked(runAgentReadTool).mock.calls[0][2]).toMatchObject({ query: `from:"bob@x.com" after:${since}` });
  });

  it('gmail_thread keeps only messages in the watched thread', async () => {
    wire([watcherRow({ kind: 'gmail_thread', value: 'gt1' })]);
    grantAccess();
    vi.mocked(runAgentReadTool).mockResolvedValue({
      ok: true,
      data: { results: [msg('m1', 'gt1'), msg('m2', 'other')] },
    });

    const res = await runWatcherSweep(NOW);

    const inserts = callsMatching('INSERT INTO thread_candidates');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].args).toContain('gmail:m1');
    expect(res.found).toBe(1);
  });

  it('hx_project keeps sessions started after since and files them as hx:<id>', async () => {
    wire([watcherRow({ kind: 'hx_project', value: 'p1', last_checked_at: '2026-10-19T11:00:00.000Z' })]);
    grantHxAccess();
    vi.mocked(runAgentReadTool).mockResolvedValue({
      ok: true,
      data: {
        sessions: [
          { id: 's-new', title: 'Kickoff', started_at: '2026-10-19T11:30:00+00:00' },
          { id: 's-old', title: 'Old', started_at: '2026-10-19T09:00:00+00:00' },
          // before last_checked_at but after the watcher's created_at: still a candidate
          { id: 's-late', title: 'Late', started_at: '2026-10-19T10:30:00+00:00' },
          { id: 's-untitled', title: '', started_at: '2026-10-19T11:45:00+00:00' },
        ],
      },
    });

    await runWatcherSweep(NOW);

    expect(runAgentReadTool).toHaveBeenCalledWith('a1', 'hermeneutix_list_sessions', { project_id: 'p1' }, { watcherId: 'w1', threadId: 't1' });
    const inserts = callsMatching('INSERT INTO thread_candidates');
    expect(inserts).toHaveLength(3);
    expect(inserts.map((q: any) => q.args[4])).toContain('hx:s-late');
    expect(inserts[0].args).toContain('hx:s-new');
    expect(inserts[0].args).toContain('hermeneutix');
    expect(inserts[0].args).toContain('Kickoff');
    expect(inserts[2].args).toContain('s-untitled');
  });

  it('hx_meeting lists by instance_id', async () => {
    wire([watcherRow({ kind: 'hx_meeting', value: 'i1' })]);
    grantHxAccess();
    vi.mocked(runAgentReadTool).mockResolvedValue({ ok: true, data: { sessions: [] } });

    await runWatcherSweep(NOW);

    expect(runAgentReadTool).toHaveBeenCalledWith('a1', 'hermeneutix_list_sessions', { instance_id: 'i1' }, { watcherId: 'w1', threadId: 't1' });
  });

  it.each(['not_enabled', 'blocked', 'needs_approval'] as const)(
    'suspends a watcher when the read comes back %s',
    async (reason) => {
      wire([watcherRow()]);
      grantAccess();
      vi.mocked(runAgentReadTool).mockResolvedValue({ ok: false, reason });

      const res = await runWatcherSweep(NOW);

      expect(callsMatching("SET status = 'suspended'")).toHaveLength(1);
      expect(callsMatching('last_checked_at = ?')).toHaveLength(0);
      expect(res).toEqual({ checked: 1, found: 0, suspended: 1 });
    }
  );

  it('suspends a watcher whose agent lost the source service, without reading', async () => {
    wire([watcherRow()]);
    vi.mocked(resolveToolPolicy).mockResolvedValue(notEnabled as never);

    const res = await runWatcherSweep(NOW);

    expect(runAgentReadTool).not.toHaveBeenCalled();
    expect(callsMatching("SET status = 'suspended'")).toHaveLength(1);
    expect(res.suspended).toBe(1);
  });

  it('treats a read error as transient: no suspend, last_checked_at not advanced', async () => {
    wire([watcherRow()]);
    grantAccess();
    vi.mocked(runAgentReadTool).mockResolvedValue({ ok: false, reason: 'error', message: 'boom' });

    const res = await runWatcherSweep(NOW);

    expect(callsMatching("SET status = 'suspended'")).toHaveLength(0);
    expect(callsMatching('last_checked_at = ?')).toHaveLength(0);
    expect(res).toEqual({ checked: 1, found: 0, suspended: 0 });
  });

  it('advances last_checked_at to now only on a successful read', async () => {
    wire([watcherRow()]);
    grantAccess();
    vi.mocked(runAgentReadTool).mockResolvedValue({ ok: true, data: { results: [] } });

    await runWatcherSweep(NOW);

    const upd = callsMatching('last_checked_at = ?');
    expect(upd).toHaveLength(1);
    expect(upd[0].args).toEqual([NOW.toISOString(), 'w1']);
  });

  it('one failing watcher does not abort the sweep', async () => {
    wire([watcherRow({ id: 'w1' }), watcherRow({ id: 'w2' })]);
    grantAccess();
    vi.mocked(runAgentReadTool)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ ok: true, data: { results: [msg('m1')] } });

    const res = await runWatcherSweep(NOW);

    expect(runAgentReadTool).toHaveBeenCalledTimes(2);
    expect(res.found).toBe(1);
    expect(callsMatching('last_checked_at = ?')[0].args).toEqual([NOW.toISOString(), 'w2']);
  });

  it('suspends a stored gmail_sender watcher whose value carries operators, without reading', async () => {
    wire([watcherRow({ value: 'bob@x.com OR in:anywhere' })]);
    grantAccess();

    const res = await runWatcherSweep(NOW);

    expect(runAgentReadTool).not.toHaveBeenCalled();
    expect(res.suspended).toBe(1);
  });

  it('walks hx_project pages up to 5 and warns when still truncated', async () => {
    wire([watcherRow({ kind: 'hx_project', value: 'p1', id: 'w9' })]);
    grantHxAccess();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(runAgentReadTool).mockImplementation((async (_a: string, _t: string, args: any) => ({
      ok: true,
      data: {
        sessions: [{ id: `s${args.page ?? 1}`, title: 'T', started_at: '2026-10-19T11:00:00+00:00' }],
        pagination: { has_next: true },
      },
    })) as never);

    const res = await runWatcherSweep(NOW);

    expect(runAgentReadTool).toHaveBeenCalledTimes(5);
    expect(vi.mocked(runAgentReadTool).mock.calls[4][2]).toEqual({ project_id: 'p1', page: 5 });
    expect(res.found).toBe(5);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('w9'));
    warn.mockRestore();
  });

  it('warns when a gmail read fills the result cap, and still advances', async () => {
    wire([watcherRow({ id: 'w7' })]);
    grantAccess();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(runAgentReadTool).mockResolvedValue({
      ok: true,
      data: { results: Array.from({ length: 50 }, (_, i) => msg(`m${i}`)) },
    });

    await runWatcherSweep(NOW);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('w7'));
    expect(callsMatching('last_checked_at = ?')).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('checkWatcherAccess value hardening', () => {
  it('refuses a sender carrying a Gmail operator before any policy lookup', async () => {
    const res = await checkWatcherAccess('a1', { kind: 'gmail_sender', value: 'bob@x.com OR in:anywhere' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toMatch(/^WATCHER_SOURCE_NOT_GRANTED/);
    expect(resolveToolPolicy).not.toHaveBeenCalled();
  });

  it('refuses a malformed gmail thread id', async () => {
    const res = await checkWatcherAccess('a1', { kind: 'gmail_thread', value: 'abc OR in:anywhere' });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toMatch(/^WATCHER_SOURCE_NOT_GRANTED/);
  });

  it('accepts a plain address, a domain and a hex thread id', async () => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(policy() as never);
    for (const [kind, value] of [['gmail_sender', 'bob@x.com'], ['gmail_sender', '@x.com'], ['gmail_thread', '18c3fa09bd']] as const) {
      expect((await checkWatcherAccess('a1', { kind, value })).ok).toBe(true);
    }
  });
});
