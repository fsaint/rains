/**
 * Threads Service Tests
 *
 * Tests for the thread root template, section parsing, minting and the brief.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  client: {
    execute: vi.fn().mockResolvedValue({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] }),
  },
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'test-id'),
}));

vi.mock('./memory.js', async () => {
  const actual = await vi.importActual<typeof import('./memory.js')>('./memory.js');
  return {
    resolveOrCreate: vi.fn(),
    setEntryParent: vi.fn(),
    ensureMemoryRoot: vi.fn(),
    splitSections: actual.splitSections,
  };
});

import { client } from '../db/index.js';
import { resolveOrCreate, setEntryParent, ensureMemoryRoot } from './memory.js';
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
  vi.mocked(resolveOrCreate).mockReset();
  vi.mocked(setEntryParent).mockReset();
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
  it('creates a thread-type root entry under the scope root and inserts an active row', async () => {
    vi.mocked(resolveOrCreate).mockResolvedValue({ row: { id: 'root-1' } as never, created: true });
    vi.mocked(ensureMemoryRoot).mockResolvedValue('scope-root');
    vi.mocked(setEntryParent).mockResolvedValue({ ok: true });

    const t = await mintThread({ userId: 'u1', scopeId: 's1', title: 'Seed round', goal: 'Close it' });

    expect(resolveOrCreate).toHaveBeenCalledWith(expect.objectContaining({ type: 'thread', title: 'Seed round', scopeId: 's1' }));
    expect(setEntryParent).toHaveBeenCalledWith('root-1', ['s1'], 'scope-root');
    expect(t).toMatchObject({ status: 'active', rootEntryId: 'root-1', scopeId: 's1' });

    const sqls = vi.mocked(client.execute).mock.calls.map((c) => (c[0] as { sql: string }).sql);
    const branchIdx = sqls.findIndex((s) => s.includes('INSERT INTO memory_branches'));
    expect(branchIdx).toBeGreaterThanOrEqual(0);
    expect(sqls.some((s) => s.includes('INSERT INTO threads'))).toBe(true);
    // the branch row exists before setEntryParent reparents it
    expect(vi.mocked(client.execute).mock.invocationCallOrder[branchIdx])
      .toBeLessThan(vi.mocked(setEntryParent).mock.invocationCallOrder[0]);
  });

  it('refuses to reuse an existing entry when resolveOrCreate matches one (created=false)', async () => {
    vi.mocked(resolveOrCreate).mockResolvedValue({ row: { id: 'root-1' } as never, created: false });
    await expect(mintThread({ userId: 'u1', scopeId: 's1', title: 'Seed round' })).rejects.toThrow(/already exists/);
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
