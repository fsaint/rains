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
  };
});

import { client, sql } from '../db/index.js';
import { ensureMemoryRoot } from './memory.js';
import {
  renderRootContent,
  parseThreadSections,
  mintThread,
  getThread,
  getThreadBrief,
  BRIEF_EVENT_LIMIT,
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
