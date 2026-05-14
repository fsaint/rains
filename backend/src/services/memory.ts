/**
 * Memory service — shared logic for the memory system.
 *
 * Extracted from api/routes.ts so it can be unit-tested independently.
 */

import { client } from '../db/index.js';
import { nanoid } from 'nanoid';

/** Extract [[wikilinks]] from Markdown content */
export function parseWikilinks(content: string): string[] {
  const matches = content.matchAll(/\[\[([^\]]+)\]\]/g);
  return [...matches].map((m) => m[1].trim()).filter((t) => t.length > 0);
}

/** Parse [[Title]] and [[Title#Heading]] refs. */
export function parseWikilinkRefs(content: string): Array<{ title: string; heading: string | null }> {
  const re = /\[\[([^\]|#]+?)(?:#([^\]|]+))?\]\]/g;
  const out: Array<{ title: string; heading: string | null }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push({ title: m[1].trim(), heading: m[2]?.trim() ?? null });
  }
  return out;
}

/** Rebuild memory_links for a single entry (after create/update) */
export async function updateLinkIndex(
  entryId: string,
  userId: string,
  content: string | null
): Promise<void> {
  // Remove existing links from this source
  await client.execute({
    sql: `DELETE FROM memory_links WHERE source_id = ?`,
    args: [entryId],
  });
  if (!content) return;

  const titles = parseWikilinks(content);
  if (titles.length === 0) return;

  // Resolve each title to an entry ID within the user's vault
  for (const title of titles) {
    const targetResult = await client.execute({
      sql: `SELECT id FROM memory_entries WHERE user_id = ? AND title = ? AND is_deleted = false LIMIT 1`,
      args: [userId, title],
    });
    if (targetResult.rows.length === 0) continue;
    const targetId = targetResult.rows[0].id as string;
    if (targetId === entryId) continue; // no self-links

    // Extract ~50 chars of context around the wikilink
    const re = new RegExp(`(.{0,30})\\[\\[${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\](.{0,30})`);
    const match = content.match(re);
    const context = match ? `${match[1]}[[${title}]]${match[2]}` : null;

    await client.execute({
      sql: `INSERT INTO memory_links (source_id, target_id, context) VALUES (?, ?, ?)
            ON CONFLICT (source_id, target_id) DO UPDATE SET context = EXCLUDED.context`,
      args: [entryId, targetId, context],
    });
  }
}

/** Extract #tags from Markdown content. Excludes markdown headings (## Foo). */
export function parseTags(content: string): string[] {
  // Strip heading lines first so # H1 headings aren't picked up as tags.
  const stripped = content.replace(/^#{1,6}\s+.*/gm, '');
  // #tag must follow whitespace or line-start, start with a letter.
  // Excludes ## headings because ## has a space after.
  const re = /(?:^|\s)#([a-z][a-z0-9-]*)/gi;
  const set = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) set.add(m[1].toLowerCase());
  return [...set];
}

/** Replace the tag index for an entry (delete+insert). */
export async function updateTagIndex(entryId: string, content: string | null): Promise<void> {
  await client.execute({ sql: `DELETE FROM memory_tags WHERE entry_id = ?`, args: [entryId] });
  if (!content) return;
  const tags = parseTags(content);
  for (const tag of tags) {
    const now = new Date().toISOString();
    await client.execute({
      sql: `INSERT INTO memory_tags (entry_id, tag, created_at) VALUES (?, ?, ?)
            ON CONFLICT (entry_id, tag) DO NOTHING`,
      args: [entryId, tag, now],
    });
  }
}

const ROOT_CONTENT = `# Memory Index

This is your persistent memory vault. Agents update this index when they learn significant new information.

## People


## Companies


## Projects


## Notes

`;

export interface DreamManifestEntry {
  id: string;
  title: string;
  type: string;
  parent_id: string | null;
  backlink_count: number;
  updated_at: string;
}

/** Compact manifest of all entries for the dream process */
export async function getDreamManifest(userId: string): Promise<DreamManifestEntry[]> {
  const result = await client.execute({
    sql: `SELECT e.id, e.title, e.type,
                 b.parent_entry_id AS parent_id,
                 COUNT(ml.source_id) AS backlink_count,
                 e.updated_at
          FROM memory_entries e
          LEFT JOIN memory_branches b ON b.entry_id = e.id
          LEFT JOIN memory_links ml ON ml.target_id = e.id
          WHERE e.user_id = ? AND e.is_deleted = false
          GROUP BY e.id, e.title, e.type, b.parent_entry_id, e.updated_at
          ORDER BY e.type ASC, e.title ASC`,
    args: [userId],
  });
  return result.rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    type: r.type as string,
    parent_id: (r.parent_id as string | null) ?? null,
    backlink_count: Number(r.backlink_count ?? 0),
    updated_at: r.updated_at as string,
  }));
}

/** Move an entry to a new parent in the tree */
export async function setEntryParent(
  entryId: string,
  userId: string,
  newParentId: string | null
): Promise<{ ok: true } | { error: string }> {
  // 1. Ownership check
  const ownerCheck = await client.execute({
    sql: `SELECT id FROM memory_entries WHERE id = ? AND user_id = ? AND is_deleted = false`,
    args: [entryId, userId],
  });
  if (ownerCheck.rows.length === 0) return { error: 'Entry not found' };

  // 2. Self-parent check
  if (newParentId === entryId) return { error: 'Cannot set an entry as its own parent' };

  // 3. Circular reference check — walk ancestors of newParentId
  if (newParentId !== null) {
    let current: string | null = newParentId;
    const visited = new Set<string>();
    while (current !== null) {
      if (current === entryId) return { error: 'Circular reference: entry is an ancestor of the new parent' };
      if (visited.has(current)) break; // infinite loop guard
      visited.add(current);
      const parentRow = await client.execute({
        sql: `SELECT parent_entry_id FROM memory_branches WHERE entry_id = ? LIMIT 1`,
        args: [current],
      });
      current = parentRow.rows.length > 0 ? (parentRow.rows[0].parent_entry_id as string | null) : null;
    }
  }

  // 4. Update
  await client.execute({
    sql: `UPDATE memory_branches SET parent_entry_id = ? WHERE entry_id = ?`,
    args: [newParentId, entryId],
  });
  return { ok: true };
}

export interface MemoryEntryRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  content: string | null;
  created_at: string;
  updated_at: string;
}

const ENTRY_TEMPLATES: Partial<Record<string, string>> = {
  person:  '## Role\n\n## Email\n\n## Relationship\n\n## Notes\n',
  company: '## Industry\n\n## Relationship\n\n## Notes\n',
  project: '## Status\n\n## Stakeholders\n\n## Notes\n',
};

/**
 * Idempotent create: find an existing entry by exact title, alias, or fuzzy
 * match (pg_trgm similarity > 0.7). If nothing matches, insert a new row.
 *
 * Returns the entry row plus a `created` flag (false = pre-existing entry).
 * The caller is responsible for creating branch/attribute records when created=true.
 */
export async function resolveOrCreate(opts: {
  userId: string;
  type: string;
  title: string;
  content?: string | null;
}): Promise<{ row: MemoryEntryRow; created: boolean }> {
  const { userId, type, title, content = null } = opts;

  // 1. Exact title match
  const exact = await client.execute({
    sql: `SELECT id, user_id, type, title, content, created_at, updated_at
          FROM memory_entries
          WHERE user_id = ? AND type = ? AND title = ? AND is_deleted = false
          LIMIT 1`,
    args: [userId, type, title],
  });
  if (exact.rows.length > 0) return { row: exact.rows[0] as unknown as MemoryEntryRow, created: false };

  // 2. Alias match (memory_attributes with name='alias')
  const aliasHit = await client.execute({
    sql: `SELECT e.id, e.user_id, e.type, e.title, e.content, e.created_at, e.updated_at
          FROM memory_attributes a
          JOIN memory_entries e ON e.id = a.entry_id
          WHERE e.user_id = ? AND e.type = ? AND e.is_deleted = false
            AND a.name = 'alias' AND a.value = ? AND a.is_deleted = false
          LIMIT 1`,
    args: [userId, type, title],
  });
  if (aliasHit.rows.length > 0) return { row: aliasHit.rows[0] as unknown as MemoryEntryRow, created: false };

  // 3. Fuzzy match via pg_trgm similarity
  const fuzzy = await client.execute({
    sql: `SELECT id, user_id, type, title, content, created_at, updated_at
          FROM memory_entries
          WHERE user_id = ? AND type = ? AND is_deleted = false
            AND similarity(title, ?) > 0.7
          ORDER BY similarity(title, ?) DESC
          LIMIT 1`,
    args: [userId, type, title, title],
  });
  if (fuzzy.rows.length > 0) return { row: fuzzy.rows[0] as unknown as MemoryEntryRow, created: false };

  // 4. Insert new entry
  const id = nanoid();
  const now = new Date().toISOString();
  const effectiveContent = content ?? ENTRY_TEMPLATES[type] ?? null;
  await client.execute({
    sql: `INSERT INTO memory_entries (id, user_id, type, title, content, is_deleted, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, false, ?, ?)`,
    args: [id, userId, type, title, effectiveContent, now, now],
  });
  return {
    row: { id, user_id: userId, type, title, content: effectiveContent, created_at: now, updated_at: now },
    created: true,
  };
}

/** Ensure user has a root Memory Index entry; create if missing */
export async function ensureMemoryRoot(userId: string): Promise<string> {
  const existing = await client.execute({
    sql: `SELECT id FROM memory_entries WHERE user_id = ? AND type = 'index' AND is_deleted = false LIMIT 1`,
    args: [userId],
  });
  if (existing.rows.length > 0) return existing.rows[0].id as string;

  const id = nanoid();
  const now = new Date().toISOString();
  await client.execute({
    sql: `INSERT INTO memory_entries (id, user_id, type, title, content, is_deleted, created_at, updated_at)
          VALUES (?, ?, 'index', 'Memory Index', ?, false, ?, ?)`,
    args: [id, userId, ROOT_CONTENT, now, now],
  });
  // Root has no branch parent
  await client.execute({
    sql: `INSERT INTO memory_branches (id, entry_id, parent_entry_id, position, is_expanded) VALUES (?, ?, NULL, 0, true)`,
    args: [nanoid(), id],
  });
  return id;
}
