/**
 * Memory service — shared logic for the memory system.
 *
 * Extracted from api/routes.ts so it can be unit-tested independently.
 */

import { client } from '../db/index.js';
import { nanoid } from 'nanoid';

/** Extract ![[Title]] transclusion references from content. */
export function parseTransclusions(content: string): string[] {
  const re = /!\[\[([^\]]+)\]\]/g;
  const titles: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) titles.push(m[1].trim());
  return titles;
}

/**
 * Look up an entry by exact title, then by alias attribute, within one scope.
 * Returns null if not found.
 *
 * Scoped, so a `![[Title]]` transclusion cannot pull content across the
 * partition — the same title in another scope is a different entry.
 */
export async function lookupEntryByTitleOrAlias(
  scopeId: string,
  title: string
): Promise<{ id: string; title: string; content: string | null } | null> {
  // 1. Exact title match
  const exact = await client.execute({
    sql: `SELECT id, title, content FROM memory_entries
          WHERE scope_id = ? AND title = ? AND is_deleted = false LIMIT 1`,
    args: [scopeId, title],
  });
  if (exact.rows.length > 0) {
    const r = exact.rows[0];
    return { id: r.id as string, title: r.title as string, content: r.content as string | null };
  }
  // 2. Alias match
  const alias = await client.execute({
    sql: `SELECT e.id, e.title, e.content FROM memory_attributes a
          JOIN memory_entries e ON e.id = a.entry_id
          WHERE e.scope_id = ? AND a.name = 'alias' AND a.value = ? AND a.is_deleted = false LIMIT 1`,
    args: [scopeId, title],
  });
  if (alias.rows.length > 0) {
    const r = alias.rows[0];
    return { id: r.id as string, title: r.title as string, content: r.content as string | null };
  }
  return null;
}

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

/**
 * Rebuild memory_links for a single entry (after create/update).
 *
 * This is the enforcement point for wikilinks: titles resolve only within the
 * entry's own scope. A `[[Title]]` pointing at an entry in another scope
 * silently fails to resolve, exactly as if the entry did not exist — which,
 * from inside that scope, it does not. Resolving across scopes would put
 * cross-partition rows in memory_links, and those leak straight back out
 * through backlinks and the graph view regardless of any grant.
 */
export async function updateLinkIndex(
  entryId: string,
  scopeId: string,
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

  // Resolve each title to an entry ID within the same scope
  for (const title of titles) {
    const targetResult = await client.execute({
      sql: `SELECT id FROM memory_entries WHERE scope_id = ? AND title = ? AND is_deleted = false LIMIT 1`,
      args: [scopeId, title],
    });
    if (targetResult.rows.length === 0) continue;
    const targetId = targetResult.rows[0].id as string;
    if (targetId === entryId) continue; // no self-links

    // Extract ~50 chars of context around the wikilink
    const re = new RegExp(`(.{0,30})\\[\\[${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\](.{0,30})`);
    const match = content.match(re);
    const context = match ? `${match[1]}[[${title}]]${match[2]}` : null;

    await client.execute({
      sql: `INSERT INTO memory_links (source_id, target_id, scope_id, context) VALUES (?, ?, ?, ?)
            ON CONFLICT (source_id, target_id) DO UPDATE SET context = EXCLUDED.context`,
      args: [entryId, targetId, scopeId, context],
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

export interface MdSection {
  level: number;
  heading: string;
  /** Line index of the heading; end is exclusive and covers nested subsections. */
  start: number;
  end: number;
}

/**
 * Split Markdown into ATX-heading sections. Lines inside ``` / ~~~ fences are
 * never headings; an unclosed fence runs to the end of the document. A
 * section's body runs to the next heading of the same or a higher level, so
 * nested subsections belong to their parent's body.
 */
export function splitSections(md: string): { lines: string[]; sections: MdSection[] } {
  const lines = md.split('\n');
  const heads: Array<{ level: number; heading: string; line: number }> = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) heads.push({ level: m[1].length, heading: m[2].trim(), line: i });
  });
  const sections = heads.map((h, idx) => {
    const next = heads.slice(idx + 1).find((n) => n.level <= h.level);
    return { level: h.level, heading: h.heading, start: h.line, end: next ? next.line : lines.length };
  });
  return { lines, sections };
}

export type SectionEdit =
  | { content: string; created: boolean }
  | { error: 'not_found'; headings: string[] };

/**
 * Replace or extend one section of a Markdown document.
 *
 * Heading match is case-insensitive on the text after the #s (trailing #s and
 * whitespace ignored), any level, first match wins. `replace` keeps the
 * heading line and swaps everything under it up to the next heading of the
 * same or higher level — nested subsections included. `append` adds to the end
 * of the section's body, creating `## Heading` at the end of the document when
 * the heading does not exist; `replace` on a missing heading reports the
 * headings that do exist instead of guessing.
 */
export function replaceSection(
  md: string,
  heading: string,
  text: string,
  mode: 'replace' | 'append'
): SectionEdit {
  const { lines, sections } = splitSections(md);
  const needle = heading.trim().toLowerCase();
  const hit = sections.find((s) => s.heading.toLowerCase() === needle);
  const body = text.replace(/\s+$/, '').split('\n');
  const endsWithNewline = md.endsWith('\n') || md === '';

  if (!hit) {
    if (mode === 'replace') return { error: 'not_found', headings: sections.map((s) => s.heading) };
    const base = md.replace(/\s+$/, '');
    const content = (base ? base + '\n\n' : '') + `## ${heading.trim()}\n\n${body.join('\n')}\n`;
    return { content, created: true };
  }

  const head = lines.slice(0, hit.start + 1);
  const rest = lines.slice(hit.end);
  const existing = lines.slice(hit.start + 1, hit.end);
  while (existing.length && existing[existing.length - 1].trim() === '') existing.pop();
  while (existing.length && existing[0].trim() === '') existing.shift();

  const middle = mode === 'replace' ? body : [...existing, ...body];
  let out = [...head, '', ...middle, ''];
  if (rest.length) out = [...out, ...rest];
  let content = out.join('\n');
  if (!rest.length) content = content.replace(/\n*$/, endsWithNewline ? '\n' : '');
  return { content, created: false };
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
  version: number;
  scope: string;
  scope_name: string;
}

/**
 * Compact manifest of all entries for the dream process, across every scope the
 * caller can reach. Each row carries its scope, so a model that ignores the
 * per-scope loop still cannot silently merge entries across the partition.
 */
export async function getDreamManifest(scopeIds: string[]): Promise<DreamManifestEntry[]> {
  if (scopeIds.length === 0) return [];
  const placeholders = scopeIds.map(() => '?').join(', ');
  const result = await client.execute({
    sql: `SELECT e.id, e.title, e.type,
                 b.parent_entry_id AS parent_id,
                 COUNT(ml.source_id) AS backlink_count,
                 e.updated_at, e.version,
                 s.slug AS scope, s.name AS scope_name
          FROM memory_entries e
          JOIN memory_scopes s ON s.id = e.scope_id
          LEFT JOIN memory_branches b ON b.entry_id = e.id
          LEFT JOIN memory_links ml ON ml.target_id = e.id
          WHERE e.scope_id IN (${placeholders}) AND e.is_deleted = false
          GROUP BY e.id, e.title, e.type, b.parent_entry_id, e.updated_at, e.version, s.slug, s.name
          ORDER BY s.name ASC, e.type ASC, e.title ASC`,
    args: scopeIds,
  });
  return result.rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    type: r.type as string,
    parent_id: (r.parent_id as string | null) ?? null,
    backlink_count: Number(r.backlink_count ?? 0),
    updated_at: r.updated_at as string,
    version: Number(r.version ?? 1),
    scope: r.scope as string,
    scope_name: r.scope_name as string,
  }));
}

/**
 * Move an entry to a new parent in the tree.
 *
 * Reparenting cannot cross scopes. The composite FK on memory_branches makes
 * that impossible at the database level too; this check exists so the caller
 * gets a sentence explaining why rather than a constraint violation.
 */
export async function setEntryParent(
  entryId: string,
  scopeIds: string[],
  newParentId: string | null
): Promise<{ ok: true } | { error: string }> {
  if (scopeIds.length === 0) return { error: 'Entry not found' };
  const placeholders = scopeIds.map(() => '?').join(', ');

  // 1. Reachability check — outside the caller's scopes is indistinguishable
  //    from nonexistent, deliberately.
  const ownerCheck = await client.execute({
    sql: `SELECT id, scope_id FROM memory_entries
          WHERE id = ? AND scope_id IN (${placeholders}) AND is_deleted = false`,
    args: [entryId, ...scopeIds],
  });
  if (ownerCheck.rows.length === 0) return { error: 'Entry not found' };
  const entryScopeId = ownerCheck.rows[0].scope_id as string;

  // 2. Self-parent check
  if (newParentId === entryId) return { error: 'Cannot set an entry as its own parent' };

  // 3. Same-scope check
  if (newParentId !== null) {
    const parentRow = await client.execute({
      sql: `SELECT scope_id FROM memory_entries WHERE id = ? AND is_deleted = false LIMIT 1`,
      args: [newParentId],
    });
    if (parentRow.rows.length === 0) return { error: 'Parent not found' };
    if ((parentRow.rows[0].scope_id as string) !== entryScopeId) {
      return { error: 'Cannot move an entry into a different scope' };
    }
  }

  // 4. Circular reference check — walk ancestors of newParentId
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

  // 5. Update
  await client.execute({
    sql: `UPDATE memory_branches SET parent_entry_id = ? WHERE entry_id = ?`,
    args: [newParentId, entryId],
  });
  return { ok: true };
}

export interface MemoryEntryRow {
  id: string;
  user_id: string;
  scope_id: string;
  type: string;
  title: string;
  content: string | null;
  created_at: string;
  updated_at: string;
  version: number;
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
 *
 * All three lookups key on scope_id rather than user_id, so the same person can
 * exist independently in two scopes. That is the intended semantics of a hard
 * partition, not an oversight: a work contact and a personal contact who happen
 * to share a name are, from each scope's point of view, unrelated.
 *
 * user_id is still written on insert; the composite (scope_id, user_id) foreign
 * key is what keeps that denormalization honest.
 */
export async function resolveOrCreate(opts: {
  userId: string;
  scopeId: string;
  type: string;
  title: string;
  content?: string | null;
}): Promise<{ row: MemoryEntryRow; created: boolean }> {
  const { userId, scopeId, type, title, content = null } = opts;

  // 1. Exact title match
  const exact = await client.execute({
    sql: `SELECT id, user_id, scope_id, type, title, content, created_at, updated_at, version
          FROM memory_entries
          WHERE scope_id = ? AND type = ? AND title = ? AND is_deleted = false
          LIMIT 1`,
    args: [scopeId, type, title],
  });
  if (exact.rows.length > 0) return { row: exact.rows[0] as unknown as MemoryEntryRow, created: false };

  // 2. Alias match (memory_attributes with name='alias')
  const aliasHit = await client.execute({
    sql: `SELECT e.id, e.user_id, e.scope_id, e.type, e.title, e.content, e.created_at, e.updated_at, e.version
          FROM memory_attributes a
          JOIN memory_entries e ON e.id = a.entry_id
          WHERE e.scope_id = ? AND e.type = ? AND e.is_deleted = false
            AND a.name = 'alias' AND a.value = ? AND a.is_deleted = false
          LIMIT 1`,
    args: [scopeId, type, title],
  });
  if (aliasHit.rows.length > 0) return { row: aliasHit.rows[0] as unknown as MemoryEntryRow, created: false };

  // 3. Fuzzy match via pg_trgm similarity
  const fuzzy = await client.execute({
    sql: `SELECT id, user_id, scope_id, type, title, content, created_at, updated_at, version
          FROM memory_entries
          WHERE scope_id = ? AND type = ? AND is_deleted = false
            AND similarity(title, ?) > 0.7
          ORDER BY similarity(title, ?) DESC
          LIMIT 1`,
    args: [scopeId, type, title, title],
  });
  if (fuzzy.rows.length > 0) return { row: fuzzy.rows[0] as unknown as MemoryEntryRow, created: false };

  // 4. Insert new entry
  const id = nanoid();
  const now = new Date().toISOString();
  const effectiveContent = content ?? ENTRY_TEMPLATES[type] ?? null;
  await client.execute({
    sql: `INSERT INTO memory_entries (id, user_id, scope_id, type, title, content, is_deleted, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, false, ?, ?)`,
    args: [id, userId, scopeId, type, title, effectiveContent, now, now],
  });
  return {
    row: {
      id, user_id: userId, scope_id: scopeId, type, title,
      content: effectiveContent, created_at: now, updated_at: now, version: 1,
    },
    created: true,
  };
}

/**
 * Ensure a scope has a root index entry; create if missing.
 *
 * The root is tracked on memory_scopes.root_entry_id rather than found by
 * `type='index' LIMIT 1`. That old guess was non-deterministic the moment an
 * agent created a second index entry — which MEMORY_POLICY.md explicitly
 * sanctions as a hierarchical hub — so which entry counted as "the root"
 * depended on row order.
 */
export async function ensureMemoryRoot(userId: string, scopeId: string): Promise<string> {
  const scope = await client.execute({
    sql: `SELECT root_entry_id, name, is_system FROM memory_scopes WHERE id = ? LIMIT 1`,
    args: [scopeId],
  });
  const existingRoot = scope.rows[0]?.root_entry_id as string | null | undefined;
  if (existingRoot) return existingRoot;

  // The migrated default scope keeps the original title so nothing user-visible
  // changes for someone who never creates a second scope.
  const scopeName = (scope.rows[0]?.name as string | undefined) ?? 'Memory';
  const title = scope.rows[0]?.is_system ? 'Memory Index' : `${scopeName} Index`;

  const id = nanoid();
  const now = new Date().toISOString();
  await client.execute({
    sql: `INSERT INTO memory_entries (id, user_id, scope_id, type, title, content, is_deleted, created_at, updated_at)
          VALUES (?, ?, ?, 'index', ?, ?, false, ?, ?)`,
    args: [id, userId, scopeId, title, ROOT_CONTENT, now, now],
  });
  // Root has no branch parent
  await client.execute({
    sql: `INSERT INTO memory_branches (id, entry_id, parent_entry_id, scope_id, position, is_expanded)
          VALUES (?, ?, NULL, ?, 0, true)`,
    args: [nanoid(), id, scopeId],
  });
  // Record it, so the next call is a single lookup rather than a guess.
  await client.execute({
    sql: `UPDATE memory_scopes SET root_entry_id = ?, updated_at = ? WHERE id = ?`,
    args: [id, now, scopeId],
  });
  return id;
}
