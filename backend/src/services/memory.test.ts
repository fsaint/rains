/**
 * Memory Service Tests
 *
 * Tests for parseWikilinks, updateLinkIndex, and ensureMemoryRoot.
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

import { client } from '../db/index.js';
import { parseWikilinks, updateLinkIndex, ensureMemoryRoot, getDreamManifest } from './memory.js';

// Helper to set up a sequence of mock return values
function mockExecuteSequence(results: Array<{ rows: Record<string, unknown>[] }>) {
  let idx = 0;
  vi.mocked(client.execute).mockImplementation(async () => {
    const result = results[idx++] ?? { rows: [] };
    return { rows: result.rows, rowsAffected: 0, lastInsertRowid: 0n, columns: [] };
  });
}

// ============================================================================
// parseWikilinks
// ============================================================================

describe('parseWikilinks', () => {
  it('extracts single wikilink', () => {
    expect(parseWikilinks('see [[John Doe]]')).toEqual(['John Doe']);
  });

  it('extracts multiple wikilinks', () => {
    expect(parseWikilinks('[[A]] and [[B]]')).toEqual(['A', 'B']);
  });

  it('handles no wikilinks', () => {
    expect(parseWikilinks('plain text')).toEqual([]);
  });

  it('handles empty string', () => {
    expect(parseWikilinks('')).toEqual([]);
  });

  it('trims whitespace', () => {
    expect(parseWikilinks('[[ John Doe ]]')).toEqual(['John Doe']);
  });

  it('ignores empty wikilinks', () => {
    // [[]] — regex [^\]]+ requires >=1 char, so no match
    expect(parseWikilinks('[[]]')).toEqual([]);
  });

  it('ignores whitespace-only wikilinks after trim', () => {
    // [[ ]] captures " " → trim → "" → filtered out
    expect(parseWikilinks('[[ ]]')).toEqual([]);
  });

  it('handles wikilinks with special chars', () => {
    expect(parseWikilinks('[[Acme & Co.]]')).toEqual(['Acme & Co.']);
  });

  it('does not match single brackets', () => {
    expect(parseWikilinks('[not a link]')).toEqual([]);
  });

  it('extracts wikilink from mixed content', () => {
    expect(parseWikilinks('Contact [[Jane Smith]] for details')).toEqual(['Jane Smith']);
  });

  it('handles multiple wikilinks in sequence', () => {
    expect(parseWikilinks('[[Alpha]] [[Beta]] [[Gamma]]')).toEqual(['Alpha', 'Beta', 'Gamma']);
  });
});

// ============================================================================
// updateLinkIndex
// ============================================================================

describe('updateLinkIndex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.execute).mockResolvedValue({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });
  });

  it('deletes old links and inserts new ones for resolved wikilinks', async () => {
    mockExecuteSequence([
      { rows: [] },                           // DELETE
      { rows: [{ id: 'target-1' }] },         // SELECT (resolve "Alice")
      { rows: [] },                           // INSERT link
    ]);

    await updateLinkIndex('entry-1', 'user-1', 'See [[Alice]] for info');

    const calls = vi.mocked(client.execute).mock.calls;
    expect(calls[0][0]).toMatchObject({ sql: expect.stringContaining('DELETE FROM memory_links') });
    expect(calls[1][0]).toMatchObject({ sql: expect.stringContaining('SELECT id FROM memory_entries') });
    expect(calls[2][0]).toMatchObject({ sql: expect.stringContaining('INSERT INTO memory_links') });
  });

  it('only deletes links when content is null', async () => {
    await updateLinkIndex('entry-1', 'user-1', null);

    const calls = vi.mocked(client.execute).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ sql: expect.stringContaining('DELETE FROM memory_links') });
  });

  it('deletes links but skips insert when no wikilinks in content', async () => {
    await updateLinkIndex('entry-1', 'user-1', 'plain text no links here');

    const calls = vi.mocked(client.execute).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ sql: expect.stringContaining('DELETE FROM memory_links') });
  });

  it('skips self-links', async () => {
    mockExecuteSequence([
      { rows: [] },                           // DELETE
      { rows: [{ id: 'entry-1' }] },          // SELECT returns same id as entryId
    ]);

    await updateLinkIndex('entry-1', 'user-1', 'See [[MySelf]]');

    const calls = vi.mocked(client.execute).mock.calls;
    // No INSERT should happen
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toMatchObject({ sql: expect.stringContaining('SELECT id FROM memory_entries') });
  });

  it('skips unresolved titles', async () => {
    mockExecuteSequence([
      { rows: [] },           // DELETE
      { rows: [] },           // SELECT — no match for "Unknown"
    ]);

    await updateLinkIndex('entry-1', 'user-1', 'See [[Unknown]]');

    const calls = vi.mocked(client.execute).mock.calls;
    expect(calls).toHaveLength(2);
    // No INSERT
    const sqls = calls.map((c) => (c[0] as { sql: string }).sql);
    expect(sqls.some((s) => s.includes('INSERT INTO memory_links'))).toBe(false);
  });

  it('extracts context snippet around the wikilink', async () => {
    mockExecuteSequence([
      { rows: [] },
      { rows: [{ id: 'target-1' }] },
      { rows: [] },
    ]);

    await updateLinkIndex('entry-1', 'user-1', 'before [[Alice]] after');

    const insertCall = vi.mocked(client.execute).mock.calls[2][0] as { args: unknown[] };
    const context = insertCall.args[2] as string;
    expect(context).toContain('[[Alice]]');
    expect(context).toContain('before');
    expect(context).toContain('after');
  });

  it('processes multiple wikilinks', async () => {
    mockExecuteSequence([
      { rows: [] },                        // DELETE
      { rows: [{ id: 'target-a' }] },      // SELECT "Alice"
      { rows: [] },                        // INSERT link to Alice
      { rows: [{ id: 'target-b' }] },      // SELECT "Bob"
      { rows: [] },                        // INSERT link to Bob
    ]);

    await updateLinkIndex('entry-1', 'user-1', '[[Alice]] and [[Bob]]');

    const calls = vi.mocked(client.execute).mock.calls;
    expect(calls).toHaveLength(5);
  });
});

// ============================================================================
// ensureMemoryRoot
// ============================================================================

describe('ensureMemoryRoot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.execute).mockResolvedValue({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });
  });

  it('returns existing root ID without creating a new one', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [{ id: 'existing-root' }],
      rowsAffected: 0, lastInsertRowid: 0n, columns: [],
    });

    const id = await ensureMemoryRoot('user-1');

    expect(id).toBe('existing-root');
    // Only the SELECT should have been called
    expect(vi.mocked(client.execute)).toHaveBeenCalledTimes(1);
  });

  it('creates root entry when none exists', async () => {
    // SELECT returns empty → no existing root
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [],
    });
    // INSERT memory_entries
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [],
    });
    // INSERT memory_branches
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [],
    });

    const id = await ensureMemoryRoot('user-1');

    expect(id).toBe('test-id');
    expect(vi.mocked(client.execute)).toHaveBeenCalledTimes(3);
  });

  it('creates root with type index and title Memory Index', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });
    vi.mocked(client.execute).mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] });
    vi.mocked(client.execute).mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] });

    await ensureMemoryRoot('user-1');

    const insertCall = vi.mocked(client.execute).mock.calls[1][0] as { sql: string; args: unknown[] };
    expect(insertCall.sql).toContain("'index'");
    expect(insertCall.sql).toContain("'Memory Index'");
    expect(insertCall.args).toContain('user-1');
  });

  it('creates branch record with null parent for root', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });
    vi.mocked(client.execute).mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] });
    vi.mocked(client.execute).mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] });

    await ensureMemoryRoot('user-1');

    const branchCall = vi.mocked(client.execute).mock.calls[2][0] as { sql: string; args: unknown[] };
    expect(branchCall.sql).toContain('INSERT INTO memory_branches');
    // parent_entry_id is NULL inline in SQL — not passed as an arg
    expect(branchCall.sql).toContain('NULL');
    // Only branch id and entry id are in args (not a separate null arg)
    expect(branchCall.args).toHaveLength(2);
  });
});

// ============================================================================
// getDreamManifest
// ============================================================================

describe('getDreamManifest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.execute).mockResolvedValue({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });
  });

  it('returns compact entries with backlink counts', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [
        { id: 'e1', title: 'Alice', type: 'person', parent_id: 'root-1', backlink_count: 3, updated_at: '2026-05-01T00:00:00Z' },
        { id: 'e2', title: 'Acme', type: 'company', parent_id: null, backlink_count: 1, updated_at: '2026-05-02T00:00:00Z' },
      ],
      rowsAffected: 0, lastInsertRowid: 0n, columns: [],
    });

    const result = await getDreamManifest('user-1');

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: 'e1', title: 'Alice', type: 'person', parent_id: 'root-1', backlink_count: 3, updated_at: '2026-05-01T00:00:00Z' });
    expect(result[1].parent_id).toBeNull();
  });

  it('calls a single SQL query', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });

    await getDreamManifest('user-1');

    expect(vi.mocked(client.execute)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
    expect(call.sql).toContain('FROM memory_entries');
    expect(call.sql).toContain('backlink_count');
    expect(call.args).toContain('user-1');
  });

  it('coerces backlink_count to number', async () => {
    // postgres.js may return COUNT() as string
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [{ id: 'e1', title: 'Note', type: 'note', parent_id: null, backlink_count: '5', updated_at: '2026-05-01Z' }],
      rowsAffected: 0, lastInsertRowid: 0n, columns: [],
    });

    const result = await getDreamManifest('user-1');

    expect(typeof result[0].backlink_count).toBe('number');
    expect(result[0].backlink_count).toBe(5);
  });

  it('returns empty array when user has no entries', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });

    const result = await getDreamManifest('user-1');

    expect(result).toEqual([]);
  });
});
