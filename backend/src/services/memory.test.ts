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
import {
  parseWikilinks,
  updateLinkIndex,
  ensureMemoryRoot,
  getDreamManifest,
  setEntryParent,
  lookupEntryByTitleOrAlias,
  resolveOrCreate,
} from './memory.js';

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

    await updateLinkIndex('entry-1', 'scope-1', 'See [[Alice]] for info');

    const calls = vi.mocked(client.execute).mock.calls;
    expect(calls[0][0]).toMatchObject({ sql: expect.stringContaining('DELETE FROM memory_links') });
    expect(calls[1][0]).toMatchObject({ sql: expect.stringContaining('SELECT id FROM memory_entries') });
    expect(calls[2][0]).toMatchObject({ sql: expect.stringContaining('INSERT INTO memory_links') });
  });

  it('only deletes links when content is null', async () => {
    await updateLinkIndex('entry-1', 'scope-1', null);

    const calls = vi.mocked(client.execute).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ sql: expect.stringContaining('DELETE FROM memory_links') });
  });

  it('deletes links but skips insert when no wikilinks in content', async () => {
    await updateLinkIndex('entry-1', 'scope-1', 'plain text no links here');

    const calls = vi.mocked(client.execute).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ sql: expect.stringContaining('DELETE FROM memory_links') });
  });

  it('skips self-links', async () => {
    mockExecuteSequence([
      { rows: [] },                           // DELETE
      { rows: [{ id: 'entry-1' }] },          // SELECT returns same id as entryId
    ]);

    await updateLinkIndex('entry-1', 'scope-1', 'See [[MySelf]]');

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

    await updateLinkIndex('entry-1', 'scope-1', 'See [[Unknown]]');

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

    await updateLinkIndex('entry-1', 'scope-1', 'before [[Alice]] after');

    const insertCall = vi.mocked(client.execute).mock.calls[2][0] as { args: unknown[] };
    // args are [source_id, target_id, scope_id, context]
    expect(insertCall.args[2]).toBe('scope-1');
    const context = insertCall.args[3] as string;
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

    await updateLinkIndex('entry-1', 'scope-1', '[[Alice]] and [[Bob]]');

    const calls = vi.mocked(client.execute).mock.calls;
    expect(calls).toHaveLength(5);
  });

  it('resolves titles within the entry\'s scope, never across the partition', async () => {
    // The enforcement point for wikilinks. If this query were keyed on user_id,
    // memory_links would hold cross-scope rows, and those leak straight back out
    // through backlinks and the graph view regardless of any grant.
    mockExecuteSequence([
      { rows: [] },
      { rows: [] }, // no match — "Alice" exists, but in another scope
    ]);

    await updateLinkIndex('entry-1', 'scope-1', 'See [[Alice]]');

    const selectCall = vi.mocked(client.execute).mock.calls[1][0] as { sql: string; args: unknown[] };
    expect(selectCall.sql).toContain('scope_id = ?');
    expect(selectCall.sql).not.toContain('user_id = ?');
    expect(selectCall.args).toEqual(['scope-1', 'Alice']);
    // Unresolved, so no link row is written.
    expect(vi.mocked(client.execute)).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// lookupEntryByTitleOrAlias — the transclusion resolver
// ============================================================================

describe('lookupEntryByTitleOrAlias', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.execute).mockResolvedValue({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });
  });

  it('looks up by title within one scope', async () => {
    mockExecuteSequence([{ rows: [{ id: 'e1', title: 'Alice', content: 'x' }] }]);

    const found = await lookupEntryByTitleOrAlias('scope-1', 'Alice');

    expect(found).toMatchObject({ id: 'e1' });
    const call = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
    expect(call.sql).toContain('scope_id = ?');
    expect(call.args).toEqual(['scope-1', 'Alice']);
  });

  it('does not find an entry that exists only in another scope', async () => {
    // Both the title and the alias lookup miss, so a ![[Title]] transclusion
    // cannot pull content across the partition.
    mockExecuteSequence([{ rows: [] }, { rows: [] }]);

    const found = await lookupEntryByTitleOrAlias('scope-1', 'Alice');

    expect(found).toBeNull();
    const aliasCall = vi.mocked(client.execute).mock.calls[1][0] as { sql: string };
    expect(aliasCall.sql).toContain('e.scope_id = ?');
  });
});

// ============================================================================
// resolveOrCreate
// ============================================================================

describe('resolveOrCreate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.execute).mockResolvedValue({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });
  });

  const opts = { userId: 'user-1', scopeId: 'scope-1', type: 'person', title: 'Alice' };

  it('returns an existing entry on an exact title match, without inserting', async () => {
    mockExecuteSequence([{ rows: [{ id: 'e1', user_id: 'user-1', scope_id: 'scope-1', type: 'person', title: 'Alice', content: null, created_at: 'n', updated_at: 'n' }] }]);

    const { row, created } = await resolveOrCreate(opts);

    expect(created).toBe(false);
    expect(row.id).toBe('e1');
    const call = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
    expect(call.sql).toContain('scope_id = ?');
    expect(call.args).toEqual(['scope-1', 'person', 'Alice']);
  });

  it('creates a separate entry when the same title exists only in another scope', async () => {
    // A hard partition means "Alice" in work and "Alice" in personal are two
    // different people as far as either scope is concerned.
    mockExecuteSequence([
      { rows: [] }, // exact — miss
      { rows: [] }, // alias — miss
      { rows: [] }, // fuzzy — miss
      { rows: [] }, // INSERT
    ]);

    const { created } = await resolveOrCreate(opts);

    expect(created).toBe(true);
    const insert = vi.mocked(client.execute).mock.calls[3][0] as { sql: string; args: unknown[] };
    expect(insert.sql).toContain('INSERT INTO memory_entries');
    expect(insert.args).toContain('scope-1');
    expect(insert.args).toContain('user-1');
  });

  it('keys the alias and fuzzy lookups on scope too', async () => {
    mockExecuteSequence([{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }]);

    await resolveOrCreate(opts);

    const alias = vi.mocked(client.execute).mock.calls[1][0] as { sql: string };
    const fuzzy = vi.mocked(client.execute).mock.calls[2][0] as { sql: string };
    expect(alias.sql).toContain('e.scope_id = ?');
    expect(fuzzy.sql).toContain('scope_id = ?');
    expect(fuzzy.sql).toContain('similarity(');
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

  it('returns the scope\'s recorded root without creating one', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [{ root_entry_id: 'existing-root', name: 'Default', is_system: true }],
      rowsAffected: 0, lastInsertRowid: 0n, columns: [],
    });

    const id = await ensureMemoryRoot('user-1', 'scope-1');

    expect(id).toBe('existing-root');
    // One lookup on memory_scopes, and nothing else.
    expect(vi.mocked(client.execute)).toHaveBeenCalledTimes(1);
  });

  it('ignores a stray type=index entry — the root is whatever the scope records', async () => {
    // MEMORY_POLICY.md sanctions extra index entries as hierarchical hubs, so
    // the old `type='index' LIMIT 1` lookup could return the wrong one. The
    // scope's root_entry_id is now the only answer.
    mockExecuteSequence([
      { rows: [{ root_entry_id: null, name: 'Work', is_system: false }] },
      { rows: [] }, // INSERT memory_entries
      { rows: [] }, // INSERT memory_branches
      { rows: [] }, // UPDATE memory_scopes.root_entry_id
    ]);

    const id = await ensureMemoryRoot('user-1', 'scope-work');

    expect(id).toBe('test-id');
    const queried = vi.mocked(client.execute).mock.calls
      .map((c) => (c[0] as { sql: string }).sql)
      .join('\n');
    expect(queried).not.toContain("type = 'index'");
  });

  it('creates the root, its branch, and records it on the scope', async () => {
    mockExecuteSequence([
      { rows: [{ root_entry_id: null, name: 'Default', is_system: true }] },
      { rows: [] }, { rows: [] }, { rows: [] },
    ]);

    const id = await ensureMemoryRoot('user-1', 'scope-1');

    expect(id).toBe('test-id');
    expect(vi.mocked(client.execute)).toHaveBeenCalledTimes(4);

    const update = vi.mocked(client.execute).mock.calls[3][0] as { sql: string; args: unknown[] };
    expect(update.sql).toContain('UPDATE memory_scopes SET root_entry_id');
    expect(update.args).toContain('test-id');
    expect(update.args).toContain('scope-1');
  });

  it('titles the default scope\'s root "Memory Index", so migration changes nothing visible', async () => {
    mockExecuteSequence([
      { rows: [{ root_entry_id: null, name: 'Default', is_system: true }] },
      { rows: [] }, { rows: [] }, { rows: [] },
    ]);

    await ensureMemoryRoot('user-1', 'scope-1');

    const insertCall = vi.mocked(client.execute).mock.calls[1][0] as { sql: string; args: unknown[] };
    expect(insertCall.sql).toContain("'index'");
    expect(insertCall.args).toContain('Memory Index');
    expect(insertCall.args).toContain('user-1');
    expect(insertCall.args).toContain('scope-1');
  });

  it('names any other scope\'s root after the scope', async () => {
    mockExecuteSequence([
      { rows: [{ root_entry_id: null, name: 'Work', is_system: false }] },
      { rows: [] }, { rows: [] }, { rows: [] },
    ]);

    await ensureMemoryRoot('user-1', 'scope-work');

    const insertCall = vi.mocked(client.execute).mock.calls[1][0] as { sql: string; args: unknown[] };
    expect(insertCall.args).toContain('Work Index');
  });

  it('creates the branch record with a null parent and the scope stamped on it', async () => {
    mockExecuteSequence([
      { rows: [{ root_entry_id: null, name: 'Default', is_system: true }] },
      { rows: [] }, { rows: [] }, { rows: [] },
    ]);

    await ensureMemoryRoot('user-1', 'scope-1');

    const branchCall = vi.mocked(client.execute).mock.calls[2][0] as { sql: string; args: unknown[] };
    expect(branchCall.sql).toContain('INSERT INTO memory_branches');
    // parent_entry_id is NULL inline in SQL — not passed as an arg
    expect(branchCall.sql).toContain('NULL');
    expect(branchCall.args).toContain('scope-1');
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

  it('returns compact entries with backlink counts, each labelled with its scope', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [
        { id: 'e1', title: 'Alice', type: 'person', parent_id: 'root-1', backlink_count: 3, updated_at: '2026-05-01T00:00:00Z', scope: 'default', scope_name: 'Default' },
        { id: 'e2', title: 'Acme', type: 'company', parent_id: null, backlink_count: 1, updated_at: '2026-05-02T00:00:00Z', scope: 'work', scope_name: 'Work' },
      ],
      rowsAffected: 0, lastInsertRowid: 0n, columns: [],
    });

    const result = await getDreamManifest(['scope-1', 'scope-2']);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 'e1', title: 'Alice', type: 'person', parent_id: 'root-1', backlink_count: 3,
      updated_at: '2026-05-01T00:00:00Z', scope: 'default', scope_name: 'Default',
    });
    // The label is what stops a model merging entries across the partition.
    expect(result[1].scope).toBe('work');
    expect(result[1].parent_id).toBeNull();
  });

  it('calls a single SQL query, filtered to the given scopes', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });

    await getDreamManifest(['scope-1', 'scope-2']);

    expect(vi.mocked(client.execute)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
    expect(call.sql).toContain('FROM memory_entries');
    expect(call.sql).toContain('backlink_count');
    expect(call.sql).toContain('e.scope_id IN (?, ?)');
    expect(call.args).toEqual(['scope-1', 'scope-2']);
  });

  it('coerces backlink_count to number', async () => {
    // postgres.js may return COUNT() as string
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [{ id: 'e1', title: 'Note', type: 'note', parent_id: null, backlink_count: '5', updated_at: '2026-05-01Z', scope: 'default', scope_name: 'Default' }],
      rowsAffected: 0, lastInsertRowid: 0n, columns: [],
    });

    const result = await getDreamManifest(['scope-1']);

    expect(typeof result[0].backlink_count).toBe('number');
    expect(result[0].backlink_count).toBe(5);
  });

  it('returns empty array when the scope has no entries', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });

    const result = await getDreamManifest(['scope-1']);

    expect(result).toEqual([]);
  });

  it('short-circuits without a query when no scopes are reachable', async () => {
    const result = await getDreamManifest([]);

    expect(result).toEqual([]);
    // An empty IN () list is a SQL syntax error, so this must never reach the DB.
    expect(vi.mocked(client.execute)).not.toHaveBeenCalled();
  });
});

// ============================================================================
// setEntryParent
// ============================================================================

describe('setEntryParent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.execute).mockResolvedValue({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });
  });

  const SCOPES = ['scope-1'];

  it('updates parent_entry_id on success', async () => {
    mockExecuteSequence([
      { rows: [{ id: 'entry-1', scope_id: 'scope-1' }] }, // reachability
      { rows: [{ scope_id: 'scope-1' }] },                 // parent's scope
      { rows: [] },                                        // ancestor walk
      { rows: [] },                                        // UPDATE branches
    ]);

    const result = await setEntryParent('entry-1', SCOPES, 'parent-1');

    expect(result).toEqual({ ok: true });
    const updateCall = vi.mocked(client.execute).mock.calls[3][0] as { sql: string; args: unknown[] };
    expect(updateCall.sql).toContain('UPDATE memory_branches SET parent_entry_id = ?');
    expect(updateCall.args).toContain('parent-1');
    expect(updateCall.args).toContain('entry-1');
  });

  it('returns error when the entry is outside the caller\'s scopes', async () => {
    // Out of scope is reported as not-found, deliberately: an entry the caller
    // cannot reach should be indistinguishable from one that does not exist.
    vi.mocked(client.execute).mockResolvedValueOnce({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });

    const result = await setEntryParent('entry-1', SCOPES, 'parent-1');

    expect(result).toMatchObject({ error: 'Entry not found' });
  });

  it('refuses to move an entry into a different scope', async () => {
    mockExecuteSequence([
      { rows: [{ id: 'entry-1', scope_id: 'scope-1' }] },
      { rows: [{ scope_id: 'scope-work' }] }, // parent lives elsewhere
    ]);

    const result = await setEntryParent('entry-1', SCOPES, 'parent-in-work');

    expect(result).toMatchObject({ error: expect.stringContaining('different scope') });
    // Rejected before the ancestor walk or the UPDATE.
    expect(vi.mocked(client.execute)).toHaveBeenCalledTimes(2);
  });

  it('returns error when the parent does not exist', async () => {
    mockExecuteSequence([
      { rows: [{ id: 'entry-1', scope_id: 'scope-1' }] },
      { rows: [] },
    ]);

    const result = await setEntryParent('entry-1', SCOPES, 'ghost');

    expect(result).toMatchObject({ error: 'Parent not found' });
  });

  it('returns error when setting parent to self', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [{ id: 'entry-1', scope_id: 'scope-1' }], rowsAffected: 0, lastInsertRowid: 0n, columns: [],
    });

    const result = await setEntryParent('entry-1', SCOPES, 'entry-1');

    expect(result).toMatchObject({ error: expect.stringContaining('own parent') });
    // No UPDATE should have been called
    expect(vi.mocked(client.execute)).toHaveBeenCalledTimes(1);
  });

  it('returns error on circular reference', async () => {
    // entry-1 → parent-X → grandparent is entry-1 (circular)
    mockExecuteSequence([
      { rows: [{ id: 'entry-1', scope_id: 'scope-1' }] },
      { rows: [{ scope_id: 'scope-1' }] },                // same scope, so the walk runs
      { rows: [{ parent_entry_id: 'entry-1' }] },         // walk: parent-X's parent is entry-1
    ]);

    const result = await setEntryParent('entry-1', SCOPES, 'parent-X');

    expect(result).toMatchObject({ error: expect.stringContaining('Circular') });
  });

  it('allows setting parent to null (top level)', async () => {
    mockExecuteSequence([
      { rows: [{ id: 'entry-1', scope_id: 'scope-1' }] },
      { rows: [] }, // UPDATE
    ]);

    const result = await setEntryParent('entry-1', SCOPES, null);

    expect(result).toEqual({ ok: true });
    const updateCall = vi.mocked(client.execute).mock.calls[1][0] as { sql: string; args: unknown[] };
    expect(updateCall.args[0]).toBeNull();
  });

  it('skips the scope and circular checks when newParentId is null', async () => {
    mockExecuteSequence([
      { rows: [{ id: 'entry-1', scope_id: 'scope-1' }] },
      { rows: [] }, // UPDATE
    ]);

    await setEntryParent('entry-1', SCOPES, null);

    // Only 2 DB calls: reachability + UPDATE.
    expect(vi.mocked(client.execute)).toHaveBeenCalledTimes(2);
  });

  it('returns not-found rather than querying when no scopes are reachable', async () => {
    const result = await setEntryParent('entry-1', [], 'parent-1');

    expect(result).toMatchObject({ error: 'Entry not found' });
    expect(vi.mocked(client.execute)).not.toHaveBeenCalled();
  });
});
