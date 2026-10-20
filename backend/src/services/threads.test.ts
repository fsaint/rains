/**
 * Threads Service Tests
 *
 * Tests for the thread root template, section parsing, minting and the brief.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const txUnsafe = vi.hoisted(() => vi.fn());
vi.mock('../db/index.js', () => ({
  client: {
    execute: vi.fn().mockResolvedValue({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] }),
  },
  sql: {
    begin: vi.fn(async (cb: (tx: { unsafe: typeof txUnsafe }) => Promise<void>) => cb({ unsafe: txUnsafe })),
  },
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'test-id'),
}));

vi.mock('./memory.js', async () => {
  const actual = await vi.importActual<typeof import('./memory.js')>('./memory.js');
  return {
    ensureMemoryRoot: vi.fn(),
    splitSections: actual.splitSections,
    replaceSection: actual.replaceSection,
    updateLinkIndex: vi.fn(),
    updateTagIndex: vi.fn(),
  };
});

import { client, sql } from '../db/index.js';
import { ensureMemoryRoot, updateLinkIndex, updateTagIndex } from './memory.js';
import {
  renderRootContent,
  parseThreadSections,
  mintThread,
  getThread,
  getThreadBrief,
  BRIEF_EVENT_LIMIT,
  addItem,
  updateItem,
  updateSections,
  acceptCandidate,
  closeThread,
  type Thread,
} from './threads.js';

const threadRow = {
  id: 't1', user_id: 'u1', scope_id: 's1', root_entry_id: 'root-1', title: 'Seed round',
  goal: 'Close it', target_date: null, status: 'active', approval_id: null,
  created_by_agent_id: null, created_at: 'now', updated_at: 'now', closed_at: null,
};

beforeEach(() => {
  vi.mocked(client.execute).mockReset();
  vi.mocked(client.execute).mockResolvedValue({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });
  txUnsafe.mockReset();
  vi.mocked(ensureMemoryRoot).mockReset();
});

describe('renderRootContent', () => {
  it('emits the five headings in order with bodies', () => {
    const md = renderRootContent({ goal: 'Close the seed round', past: 'Met Ana', now: 'Term sheet out', next: 'Sign by Nov 1' });
    expect(md).toBe('## Goal\n\nClose the seed round\n\n## Past\n\nMet Ana\n\n## Now\n\nTerm sheet out\n\n## Next\n\nSign by Nov 1\n\n## Retrospective\n\n');
  });
});

describe('parseThreadSections', () => {
  it('treats a missing heading as empty', () => {
    expect(parseThreadSections('## Goal\n\nG\n\n## Now\n\nN\n')).toEqual({ Goal: 'G', Past: '', Now: 'N', Next: '', Retrospective: '' });
  });
  it('returns all-empty for null content', () => {
    expect(parseThreadSections(null).Now).toBe('');
  });
});

describe('mintThread', () => {
  it('writes a thread-type root entry, a branch under the scope root, and an active row in one transaction', async () => {
    vi.mocked(ensureMemoryRoot).mockResolvedValue('scope-root');

    const t = await mintThread({ userId: 'u1', scopeId: 's1', title: 'Seed round', goal: 'Close it' });

    expect(t).toMatchObject({ status: 'active', scopeId: 's1', title: 'Seed round' });
    expect(t.rootEntryId).toBe('test-id');
    expect(sql.begin).toHaveBeenCalledTimes(1);
    const calls = txUnsafe.mock.calls as Array<[string, unknown[]]>;
    expect(calls).toHaveLength(3);
    expect(calls[0][0]).toContain('INSERT INTO memory_entries');
    expect(calls[0][0]).toContain("'thread'");
    expect(calls[0][1]).toContain(renderRootContent({ goal: 'Close it' }));
    expect(calls[1][0]).toContain('INSERT INTO memory_branches');
    expect(calls[1][1]).toContain('scope-root');
    expect(calls[2][0]).toContain('INSERT INTO threads');
  });

  it('refuses when a non-closed thread with the same title exists in the scope', async () => {
    vi.mocked(ensureMemoryRoot).mockResolvedValue('scope-root');
    vi.mocked(client.execute).mockResolvedValue({ rows: [{ id: 'other' }], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });
    await expect(mintThread({ userId: 'u1', scopeId: 's1', title: ' Seed Round ' })).rejects.toThrow(/already exists/);
    const call = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
    expect(call.sql).toContain("status <> 'closed'");
    expect(call.args).toEqual(['s1', 'seed round']);
    expect(txUnsafe).not.toHaveBeenCalled();
  });

  it('allows a mint when only a closed thread has the title (the check ignores closed rows)', async () => {
    vi.mocked(ensureMemoryRoot).mockResolvedValue('scope-root');
    // the dup query filters closed threads out in SQL, so it returns no rows
    await expect(mintThread({ userId: 'u1', scopeId: 's1', title: 'Board prep' })).resolves.toMatchObject({ status: 'active' });
  });

  it('propagates a failure from inside the transaction so nothing is committed', async () => {
    vi.mocked(ensureMemoryRoot).mockResolvedValue('scope-root');
    txUnsafe.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('fk violation'));
    await expect(mintThread({ userId: 'u1', scopeId: 's1', title: 'X' })).rejects.toThrow('fk violation');
  });
});

describe('getThread', () => {
  it('returns null when the thread scope is not in scopeIds', async () => {
    expect(await getThread('t1', ['other'])).toBeNull();
    const call = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
    expect(call.sql).toContain('scope_id IN');
    expect(call.args).toEqual(['t1', 'other']);
  });
});

describe('getThreadBrief', () => {
  it('caps events at BRIEF_EVENT_LIMIT and includes activeCount', async () => {
    vi.mocked(client.execute).mockImplementation(async (stmt) => {
      const { sql } = stmt as { sql: string };
      let rows: Record<string, unknown>[] = [];
      if (sql.includes('FROM threads WHERE id')) rows = [threadRow];
      else if (sql.includes('FROM memory_entries')) rows = [{ content: '## Goal\n\nG\n' }];
      else if (sql.includes('COUNT(*)')) rows = [{ n: 3 }];
      return { rows, rowsAffected: 0, lastInsertRowid: 0n, columns: [] };
    });

    const brief = await getThreadBrief('t1', ['s1']);

    expect(brief?.activeCount).toBe(3);
    expect(brief?.sections.Goal).toBe('G');
    const eventCall = vi.mocked(client.execute).mock.calls
      .map((c) => c[0] as { sql: string; args: unknown[] })
      .find((c) => c.sql.includes("kind = 'event'"));
    expect(eventCall?.sql).toContain('LIMIT ?');
    expect(eventCall?.args).toContain(BRIEF_EVENT_LIMIT);
    expect(BRIEF_EVENT_LIMIT).toBe(20);
  });
});

const thread: Thread = {
  id: 't1', userId: 'u1', scopeId: 's1', rootEntryId: 'root-1', title: 'Seed round', goal: null,
  targetDate: null, status: 'active', approvalId: null, createdByAgentId: null,
  createdAt: 'now', updatedAt: 'now', closedAt: null,
};
const res = (rows: Record<string, unknown>[]) => ({ rows, rowsAffected: 0, lastInsertRowid: 0n, columns: [] });
const itemRow = (o: Record<string, unknown> = {}) => ({
  id: 'i1', thread_id: 't1', kind: 'todo', title: 'Send deck', body: null, occurred_at: null,
  due_at: 'D1', remind_at: 'R1', status: 'open', nudge_fired_at: 'N', fired_at: 'F',
  acknowledged_at: 'A', memory_entry_id: null, source_type: null, source_ref: null, created_at: 'c', ...o,
});
const execCalls = () => vi.mocked(client.execute).mock.calls.map((c) => c[0] as { sql: string; args: unknown[] });
const updateCall = () => execCalls().find((c) => c.sql.startsWith('UPDATE thread_items'))!;

describe('addItem', () => {
  it('throws THREAD_CLOSED on a closed thread', async () => {
    await expect(addItem({ ...thread, status: 'closed' }, { kind: 'todo', title: 'x' })).rejects.toMatchObject({ code: 'THREAD_CLOSED' });
  });
  it('defaults occurredAt to now for events only', async () => {
    const ev = await addItem(thread, { kind: 'event', title: 'Met Ana' });
    const todo = await addItem(thread, { kind: 'todo', title: 'Send deck' });
    expect(ev.occurredAt).not.toBeNull();
    expect(todo.occurredAt).toBeNull();
  });
});

describe('updateItem', () => {
  beforeEach(() => {
    vi.mocked(client.execute).mockImplementation(async (stmt) =>
      (stmt as { sql: string }).sql.startsWith('SELECT * FROM thread_items') ? res([itemRow()]) : res([]));
  });
  it('clears nudge_fired_at and acknowledged_at when remindAt changes', async () => {
    await updateItem(thread, 'i1', { remindAt: 'R2' });
    expect(updateCall().sql).toContain('nudge_fired_at = NULL');
    expect(updateCall().sql).toContain('acknowledged_at = NULL');
  });
  it('clears fired_at and acknowledged_at when dueAt changes', async () => {
    await updateItem(thread, 'i1', { dueAt: 'D2' });
    expect(updateCall().sql).toContain('fired_at = NULL');
    expect(updateCall().sql).not.toContain('nudge_fired_at = NULL');
    expect(updateCall().sql).toContain('acknowledged_at = NULL');
  });
  it('leaves stamps alone when only the title changes', async () => {
    await updateItem(thread, 'i1', { title: 'New' });
    expect(updateCall().sql).not.toContain('= NULL');
  });
});

describe('updateSections', () => {
  const rootContent = (c: string) =>
    vi.mocked(client.execute).mockImplementation(async (stmt) =>
      (stmt as { sql: string }).sql.includes('SELECT content') ? res([{ content: c }]) : res([]));

  it('replaces ## Now, bumps the version and reindexes', async () => {
    rootContent(renderRootContent({ now: 'old' }));
    await updateSections(thread, { Now: { text: 'fresh', mode: 'replace' } });
    const upd = execCalls().find((c) => c.sql.includes('UPDATE memory_entries'))!;
    expect(upd.sql).toContain('version = version + 1');
    expect(upd.args[0]).toContain('## Now\n\nfresh');
    expect(upd.args[0]).not.toContain('old');
    expect(updateLinkIndex).toHaveBeenCalledWith('root-1', 's1', upd.args[0]);
    expect(updateTagIndex).toHaveBeenCalledWith('root-1', upd.args[0]);
  });
  it('re-adds a missing heading when a replace finds none', async () => {
    rootContent('## Goal\n\nG\n');
    await updateSections(thread, { Now: { text: 'fresh', mode: 'replace' } });
    const upd = execCalls().find((c) => c.sql.includes('UPDATE memory_entries'))!;
    expect(upd.args[0]).toContain('## Now\n\nfresh');
  });
});

describe('acceptCandidate', () => {
  it('creates a child note under the root, labels it with the source id and logs a linked event', async () => {
    vi.mocked(client.execute).mockResolvedValue(res([{
      id: 'c1', thread_id: 't1', watcher_id: null, source_type: 'gmail', source_ref: 'gmail:abc',
      summary: 'Term sheet', found_at: 'f', status: 'pending',
    }]));
    const item = await acceptCandidate(thread, 'c1');
    const calls = txUnsafe.mock.calls as Array<[string, unknown[]]>;
    expect(calls[0][0]).toContain('INSERT INTO memory_entries');
    expect(calls[1][0]).toContain('INSERT INTO memory_branches');
    expect(calls[1][1]).toContain('root-1');
    expect(calls[2][0]).toContain('INSERT INTO memory_attributes');
    expect(calls[2][1]).toEqual(expect.arrayContaining(['gmail_message_id', 'abc']));
    expect(calls[4][0]).toContain("status = 'accepted'");
    expect(item).toMatchObject({ kind: 'event', memoryEntryId: 'test-id', sourceRef: 'gmail:abc' });
  });
});

describe('closeThread', () => {
  const closeMocks = (successor: Record<string, unknown>[]) =>
    vi.mocked(client.execute).mockImplementation(async (stmt) => {
      const { sql: q } = stmt as { sql: string };
      if (q.includes("FROM thread_items")) return res([itemRow({ id: 'i1' }), itemRow({ id: 'i2', title: 'Call Bo' })]);
      if (q.includes('SELECT content')) return res([{ content: renderRootContent({}) }]);
      if (q.includes('FROM threads')) return res(successor);
      return res([]);
    });
  const succRow = { ...threadRow, id: 't2', title: 'Next round' };

  it('writes the retrospective, cancels and carries items, sets closed_at', async () => {
    closeMocks([succRow]);
    const closed = await closeThread(thread, {
      retrospective: 'Went well',
      decisions: [
        { itemId: 'i1', action: 'carry', successorThreadId: 't2' },
        { itemId: 'i2', action: 'carry' },
      ],
    });
    expect(closed.status).toBe('closed');
    const calls = txUnsafe.mock.calls as Array<[string, unknown[]]>;
    const root = calls.find((c) => c[0].includes('UPDATE memory_entries'))!;
    expect(root[1][0]).toContain('Went well');
    expect(root[1][0]).toContain('### Open loops\n\n- [ ] Call Bo');
    const copy = calls.find((c) => c[0].includes('INSERT INTO thread_items'))!;
    expect(copy[1][1]).toBe('t2');
    expect(calls.some((c) => c[0].includes("status = 'cancelled', body") && String(c[1][0]).includes('(carried to Next round)'))).toBe(true);
    expect(calls.filter((c) => c[0].includes("'cancelled'"))).toHaveLength(2);
    expect(calls.some((c) => c[0].includes("status = 'closed'"))).toBe(true);
  });

  it('throws SUCCESSOR_INVALID and writes nothing for a closed or other-user successor', async () => {
    closeMocks([]);
    await expect(closeThread(thread, {
      retrospective: 'r', decisions: [{ itemId: 'i1', action: 'carry', successorThreadId: 'bad' }],
    })).rejects.toMatchObject({ code: 'SUCCESSOR_INVALID' });
    expect(txUnsafe).not.toHaveBeenCalled();
    const q = execCalls().find((c) => c.args[0] === 'bad')!;
    expect(q.sql).toContain("status = 'active'");
    expect(q.args).toContain('u1');
  });
});
