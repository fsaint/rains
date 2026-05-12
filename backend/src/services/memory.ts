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
