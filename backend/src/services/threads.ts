/**
 * Threads Service
 *
 * A thread is a time-bound focus topic. Its narrative is an ordinary memory
 * entry (the root); the tables in db/index.ts hold the timeline, watchers and
 * candidates around it. This module covers minting, reading, items, section
 * edits, candidates and closing.
 */

import { nanoid } from 'nanoid';
import { client, sql } from '../db/index.js';
import { ensureMemoryRoot, splitSections, replaceSection, updateLinkIndex, updateTagIndex } from './memory.js';

export type ThreadStatus = 'active' | 'paused' | 'closed';
export type ThreadItemKind = 'event' | 'todo' | 'deadline' | 'reminder' | 'milestone';
export type ThreadItemStatus = 'open' | 'done' | 'cancelled';
export type SourceType = 'gmail' | 'hermeneutix' | 'memory' | 'manual';

export const THREAD_SOFT_CAP = 5;
export const BRIEF_EVENT_LIMIT = 20;
export const THREAD_SECTIONS = ['Goal', 'Past', 'Now', 'Next', 'Retrospective'] as const;

type SectionName = (typeof THREAD_SECTIONS)[number];

export interface Thread {
  id: string;
  userId: string;
  scopeId: string;
  rootEntryId: string;
  title: string;
  goal: string | null;
  targetDate: string | null;
  status: ThreadStatus;
  approvalId: string | null;
  createdByAgentId: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface ThreadItem {
  id: string;
  threadId: string;
  kind: ThreadItemKind;
  title: string;
  body: string | null;
  occurredAt: string | null;
  dueAt: string | null;
  remindAt: string | null;
  status: ThreadItemStatus;
  nudgeFiredAt: string | null;
  firedAt: string | null;
  acknowledgedAt: string | null;
  memoryEntryId: string | null;
  sourceType: SourceType | null;
  sourceRef: string | null;
  createdAt: string;
}

export interface ThreadCandidate {
  id: string;
  threadId: string;
  watcherId: string | null;
  sourceType: SourceType;
  sourceRef: string;
  summary: string;
  foundAt: string;
  status: 'pending' | 'accepted' | 'dismissed';
}

export interface MintInput {
  userId: string;
  scopeId: string;
  title: string;
  goal?: string | null;
  targetDate?: string | null;
  past?: string;
  now?: string;
  next?: string;
  approvalId?: string | null;
  createdByAgentId?: string | null;
}

export interface ThreadBrief {
  thread: Thread;
  sections: Record<SectionName, string>;
  events: ThreadItem[];
  openTodos: ThreadItem[];
  upcoming: ThreadItem[];
  firedUnacknowledged: ThreadItem[];
  pendingCandidates: ThreadCandidate[];
  activeCount: number;
}

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (v == null ? null : (v as string));

function mapThread(r: Row): Thread {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    scopeId: r.scope_id as string,
    rootEntryId: r.root_entry_id as string,
    title: r.title as string,
    goal: str(r.goal),
    targetDate: str(r.target_date),
    status: r.status as ThreadStatus,
    approvalId: str(r.approval_id),
    createdByAgentId: str(r.created_by_agent_id),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    closedAt: str(r.closed_at),
  };
}

function mapItem(r: Row): ThreadItem {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    kind: r.kind as ThreadItemKind,
    title: r.title as string,
    body: str(r.body),
    occurredAt: str(r.occurred_at),
    dueAt: str(r.due_at),
    remindAt: str(r.remind_at),
    status: r.status as ThreadItemStatus,
    nudgeFiredAt: str(r.nudge_fired_at),
    firedAt: str(r.fired_at),
    acknowledgedAt: str(r.acknowledged_at),
    memoryEntryId: str(r.memory_entry_id),
    sourceType: str(r.source_type) as SourceType | null,
    sourceRef: str(r.source_ref),
    createdAt: r.created_at as string,
  };
}

function mapCandidate(r: Row): ThreadCandidate {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    watcherId: str(r.watcher_id),
    sourceType: r.source_type as SourceType,
    sourceRef: r.source_ref as string,
    summary: r.summary as string,
    foundAt: r.found_at as string,
    status: r.status as ThreadCandidate['status'],
  };
}

/** The root entry body: the five headings in order, each followed by its text. */
export function renderRootContent(input: { goal?: string | null; past?: string; now?: string; next?: string }): string {
  const bodies: Record<SectionName, string> = {
    Goal: input.goal ?? '',
    Past: input.past ?? '',
    Now: input.now ?? '',
    Next: input.next ?? '',
    Retrospective: '',
  };
  return THREAD_SECTIONS.map((h) => `## ${h}\n\n${bodies[h]}`).join('\n\n');
}

/** Read the five sections out of root content; a missing heading is empty. */
export function parseThreadSections(content: string | null): ThreadBrief['sections'] {
  const out = Object.fromEntries(THREAD_SECTIONS.map((h) => [h, ''])) as ThreadBrief['sections'];
  if (!content) return out;
  const { lines, sections } = splitSections(content);
  for (const h of THREAD_SECTIONS) {
    const s = sections.find((x) => x.heading.toLowerCase() === h.toLowerCase());
    if (s) out[h] = lines.slice(s.start + 1, s.end).join('\n').trim();
  }
  return out;
}

export async function mintThread(input: MintInput): Promise<Thread> {
  const { userId, scopeId, title } = input;
  const goal = input.goal ?? null;
  const targetDate = input.targetDate ?? null;

  // Only a live thread of the same name blocks a mint. resolveOrCreate's fuzzy
  // match would also refuse similar titles and the title of a closed thread.
  const dup = await client.execute({
    sql: `SELECT id FROM threads
          WHERE scope_id = ? AND status <> 'closed' AND lower(trim(title)) = ? LIMIT 1`,
    args: [scopeId, title.trim().toLowerCase()],
  });
  if (dup.rows.length > 0) throw new Error(`A thread named "${title}" already exists in this scope`);

  const scopeRootId = await ensureMemoryRoot(userId, scopeId);
  const entryId = nanoid();
  const id = nanoid();
  const now = new Date().toISOString();
  const content = renderRootContent({ goal, past: input.past, now: input.now, next: input.next });

  // Entry, branch and thread row commit together, so a failure cannot leave a
  // root entry with no thread behind it. The branch is written with its parent
  // directly (as POST /api/memory/entries does) rather than through
  // setEntryParent, which reads through the non-transactional client.
  await sql.begin(async (tx) => {
    await tx.unsafe(
      `INSERT INTO memory_entries (id, user_id, scope_id, type, title, content, is_deleted, created_at, updated_at)
       VALUES ($1, $2, $3, 'thread', $4, $5, false, $6, $6)`,
      [entryId, userId, scopeId, title, content, now],
    );
    await tx.unsafe(
      `INSERT INTO memory_branches (id, entry_id, parent_entry_id, scope_id, position, is_expanded)
       VALUES ($1, $2, $3, $4,
         (SELECT COALESCE(MAX(position), -1) + 1 FROM memory_branches WHERE parent_entry_id = $3), false)`,
      [nanoid(), entryId, scopeRootId, scopeId],
    );
    await tx.unsafe(
      `INSERT INTO threads (id, user_id, scope_id, root_entry_id, title, goal, target_date, status,
                            approval_id, created_by_agent_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, $10)`,
      [id, userId, scopeId, entryId, title, goal, targetDate,
        input.approvalId ?? null, input.createdByAgentId ?? null, now],
    );
  });

  return {
    id, userId, scopeId, rootEntryId: entryId, title, goal, targetDate, status: 'active',
    approvalId: input.approvalId ?? null, createdByAgentId: input.createdByAgentId ?? null,
    createdAt: now, updatedAt: now, closedAt: null,
  };
}

export async function getThread(id: string, scopeIds: string[]): Promise<Thread | null> {
  if (scopeIds.length === 0) return null;
  const placeholders = scopeIds.map(() => '?').join(', ');
  const result = await client.execute({
    sql: `SELECT * FROM threads WHERE id = ? AND scope_id IN (${placeholders}) LIMIT 1`,
    args: [id, ...scopeIds],
  });
  return result.rows.length > 0 ? mapThread(result.rows[0] as Row) : null;
}

export async function listThreads(scopeIds: string[], status?: ThreadStatus): Promise<Thread[]> {
  if (scopeIds.length === 0) return [];
  const placeholders = scopeIds.map(() => '?').join(', ');
  const args: unknown[] = [...scopeIds];
  let where = `scope_id IN (${placeholders})`;
  if (status) {
    where += ' AND status = ?';
    args.push(status);
  }
  const result = await client.execute({
    sql: `SELECT * FROM threads WHERE ${where} ORDER BY updated_at DESC`,
    args: args as never[],
  });
  return result.rows.map((r) => mapThread(r as Row));
}

export async function countActiveThreads(userId: string): Promise<number> {
  const result = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM threads WHERE user_id = ? AND status = 'active'`,
    args: [userId],
  });
  return Number(result.rows[0]?.n ?? 0);
}

export async function getThreadBrief(id: string, scopeIds: string[]): Promise<ThreadBrief | null> {
  const thread = await getThread(id, scopeIds);
  if (!thread) return null;

  const items = async (where: string, order: string, limit: number): Promise<ThreadItem[]> => {
    const r = await client.execute({
      sql: `SELECT * FROM thread_items WHERE thread_id = ? AND ${where} ORDER BY ${order} LIMIT ?`,
      args: [id, limit],
    });
    return r.rows.map((row) => mapItem(row as Row));
  };

  const root = await client.execute({
    sql: `SELECT content FROM memory_entries WHERE id = ? AND is_deleted = false LIMIT 1`,
    args: [thread.rootEntryId],
  });
  const events = await items("kind = 'event'", 'occurred_at DESC', BRIEF_EVENT_LIMIT);
  const openTodos = await items("kind = 'todo' AND status = 'open'", 'due_at ASC', 100);
  const upcoming = await items(
    "status = 'open' AND (due_at IS NOT NULL OR remind_at IS NOT NULL)",
    'COALESCE(remind_at, due_at) ASC',
    20,
  );
  const firedUnacknowledged = await items(
    '(fired_at IS NOT NULL OR nudge_fired_at IS NOT NULL) AND acknowledged_at IS NULL',
    'COALESCE(fired_at, nudge_fired_at) ASC',
    100,
  );
  const candidates = await client.execute({
    sql: `SELECT * FROM thread_candidates WHERE thread_id = ? AND status = 'pending' ORDER BY found_at ASC`,
    args: [id],
  });

  return {
    thread,
    sections: parseThreadSections((root.rows[0]?.content as string | null) ?? null),
    events,
    openTodos,
    upcoming,
    firedUnacknowledged,
    pendingCandidates: candidates.rows.map((r) => mapCandidate(r as Row)),
    activeCount: await countActiveThreads(thread.userId),
  };
}

export class ThreadError extends Error {
  constructor(
    public code: 'THREAD_CLOSED' | 'SUCCESSOR_INVALID' | 'NOT_FOUND' | 'INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'ThreadError';
  }
}

export interface ItemInput {
  kind: ThreadItemKind;
  title: string;
  body?: string | null;
  occurredAt?: string | null;
  dueAt?: string | null;
  remindAt?: string | null;
  memoryEntryId?: string | null;
  sourceType?: SourceType | null;
  sourceRef?: string | null;
}

export interface CloseInput {
  retrospective: string;
  decisions: Array<{ itemId: string; action: 'cancel' | 'carry'; successorThreadId?: string }>;
}

const SOURCE_LABELS: Partial<Record<SourceType, { name: string; prefix: string }>> = {
  gmail: { name: 'gmail_message_id', prefix: 'gmail:' },
  hermeneutix: { name: 'hx_session_id', prefix: 'hx:' },
};

function assertWritable(thread: Thread): void {
  if (thread.status === 'closed') throw new ThreadError('THREAD_CLOSED', 'This thread is closed');
}

async function getItem(thread: Thread, itemId: string): Promise<ThreadItem> {
  const r = await client.execute({
    sql: `SELECT * FROM thread_items WHERE id = ? AND thread_id = ? LIMIT 1`,
    args: [itemId, thread.id],
  });
  if (r.rows.length === 0) throw new ThreadError('NOT_FOUND', 'Item not found in this thread');
  return mapItem(r.rows[0] as Row);
}

const touch = (thread: Thread, now: string) =>
  client.execute({ sql: `UPDATE threads SET updated_at = ? WHERE id = ?`, args: [now, thread.id] });

export async function addItem(thread: Thread, input: ItemInput): Promise<ThreadItem> {
  assertWritable(thread);
  const id = nanoid();
  const now = new Date().toISOString();
  const occurredAt = input.occurredAt ?? (input.kind === 'event' ? now : null);
  await client.execute({
    sql: `INSERT INTO thread_items (id, thread_id, kind, title, body, occurred_at, due_at, remind_at, status,
                                    memory_entry_id, source_type, source_ref, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
    args: [id, thread.id, input.kind, input.title, input.body ?? null, occurredAt,
      input.dueAt ?? null, input.remindAt ?? null, input.memoryEntryId ?? null,
      input.sourceType ?? null, input.sourceRef ?? null, now],
  });
  await touch(thread, now);
  return {
    id, threadId: thread.id, kind: input.kind, title: input.title, body: input.body ?? null,
    occurredAt, dueAt: input.dueAt ?? null, remindAt: input.remindAt ?? null, status: 'open',
    nudgeFiredAt: null, firedAt: null, acknowledgedAt: null, memoryEntryId: input.memoryEntryId ?? null,
    sourceType: input.sourceType ?? null, sourceRef: input.sourceRef ?? null, createdAt: now,
  };
}

export async function updateItem(
  thread: Thread,
  itemId: string,
  patch: Partial<Pick<ThreadItem, 'title' | 'body' | 'dueAt' | 'remindAt' | 'status'>>,
): Promise<ThreadItem> {
  assertWritable(thread);
  const current = await getItem(thread, itemId);

  const sets: string[] = [];
  const args: unknown[] = [];
  const set = (col: string, v: unknown) => { sets.push(`${col} = ?`); args.push(v); };
  if (patch.title !== undefined) set('title', patch.title);
  if (patch.body !== undefined) set('body', patch.body);
  if (patch.status !== undefined) set('status', patch.status);
  // Moving a date re-arms its notification and un-acknowledges the old one.
  if (patch.remindAt !== undefined) {
    set('remind_at', patch.remindAt);
    if (patch.remindAt !== current.remindAt) {
      sets.push('nudge_fired_at = NULL', 'acknowledged_at = NULL');
      // A reminder's nudge is its only firing, so it stamps fired_at too.
      if (current.kind === 'reminder') sets.push('fired_at = NULL');
    }
  }
  if (patch.dueAt !== undefined) {
    set('due_at', patch.dueAt);
    if (patch.dueAt !== current.dueAt) sets.push('fired_at = NULL', 'acknowledged_at = NULL');
  }
  if (sets.length === 0) return current;

  await client.execute({
    sql: `UPDATE thread_items SET ${sets.join(', ')} WHERE id = ? AND thread_id = ?`,
    args: [...args, itemId, thread.id] as never[],
  });
  await touch(thread, new Date().toISOString());
  return getItem(thread, itemId);
}

export async function acknowledgeItem(thread: Thread, itemId: string): Promise<void> {
  assertWritable(thread);
  await getItem(thread, itemId);
  await client.execute({
    sql: `UPDATE thread_items SET acknowledged_at = ? WHERE id = ? AND thread_id = ?`,
    args: [new Date().toISOString(), itemId, thread.id],
  });
}

/** Replace a section, or append when the heading is missing (replace reports not_found). */
function applySection(content: string, heading: string, text: string, mode: 'replace' | 'append'): string {
  let edit = replaceSection(content, heading, text, mode);
  if ('error' in edit) edit = replaceSection(content, heading, text, 'append');
  return (edit as { content: string }).content;
}

async function readRootContent(thread: Thread): Promise<string> {
  const r = await client.execute({
    sql: `SELECT content FROM memory_entries WHERE id = ? AND is_deleted = false LIMIT 1`,
    args: [thread.rootEntryId],
  });
  if (r.rows.length === 0) throw new ThreadError('NOT_FOUND', 'Thread root entry not found');
  return (r.rows[0].content as string | null) ?? '';
}

export async function updateSections(
  thread: Thread,
  edits: Partial<Record<'Now' | 'Next' | 'Past' | 'Goal', { text: string; mode: 'replace' | 'append' }>>,
): Promise<void> {
  assertWritable(thread);
  let content = await readRootContent(thread);
  for (const [heading, e] of Object.entries(edits)) {
    if (e) content = applySection(content, heading, e.text, e.mode);
  }
  const now = new Date().toISOString();
  await client.execute({
    sql: `UPDATE memory_entries SET content = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    args: [content, now, thread.rootEntryId],
  });
  await updateLinkIndex(thread.rootEntryId, thread.scopeId, content);
  await updateTagIndex(thread.rootEntryId, content);
  await touch(thread, now);
}

export async function setThreadStatus(thread: Thread, status: 'active' | 'paused'): Promise<Thread> {
  assertWritable(thread);
  const now = new Date().toISOString();
  await client.execute({
    sql: `UPDATE threads SET status = ?, updated_at = ? WHERE id = ?`,
    args: [status, now, thread.id],
  });
  return { ...thread, status, updatedAt: now };
}

async function getPendingCandidate(thread: Thread, candidateId: string): Promise<ThreadCandidate> {
  const r = await client.execute({
    sql: `SELECT * FROM thread_candidates WHERE id = ? AND thread_id = ? AND status = 'pending' LIMIT 1`,
    args: [candidateId, thread.id],
  });
  if (r.rows.length === 0) throw new ThreadError('NOT_FOUND', 'Pending candidate not found');
  return mapCandidate(r.rows[0] as Row);
}

export async function acceptCandidate(thread: Thread, candidateId: string): Promise<ThreadItem> {
  assertWritable(thread);
  const cand = await getPendingCandidate(thread, candidateId);
  const entryId = nanoid();
  const itemId = nanoid();
  const now = new Date().toISOString();
  const label = SOURCE_LABELS[cand.sourceType];

  // Written directly, not through resolveOrCreate: its fuzzy title match could
  // attach the candidate to an unrelated existing note.
  await sql.begin(async (tx) => {
    // Claim first: a second accept of the same candidate gets no row back.
    const claimed = await tx.unsafe(
      `UPDATE thread_candidates SET status = 'accepted'
       WHERE id = $1 AND thread_id = $2 AND status = 'pending' RETURNING id`,
      [candidateId, thread.id],
    );
    if (!claimed || claimed.length === 0) throw new ThreadError('INVALID', 'Candidate already handled');
    await tx.unsafe(
      `INSERT INTO memory_entries (id, user_id, scope_id, type, title, content, is_deleted, created_at, updated_at)
       VALUES ($1, $2, $3, 'note', $4, $4, false, $5, $5)`,
      [entryId, thread.userId, thread.scopeId, cand.summary, now],
    );
    await tx.unsafe(
      `INSERT INTO memory_branches (id, entry_id, parent_entry_id, scope_id, position, is_expanded)
       VALUES ($1, $2, $3, $4,
         (SELECT COALESCE(MAX(position), -1) + 1 FROM memory_branches WHERE parent_entry_id = $3), false)`,
      [nanoid(), entryId, thread.rootEntryId, thread.scopeId],
    );
    if (label) {
      await tx.unsafe(
        `INSERT INTO memory_attributes (id, entry_id, type, name, value, position, is_deleted, created_at)
         VALUES ($1, $2, 'label', $3, $4, 0, false, $5)`,
        [nanoid(), entryId, label.name, cand.sourceRef.startsWith(label.prefix) ? cand.sourceRef.slice(label.prefix.length) : cand.sourceRef, now],
      );
    }
    await tx.unsafe(
      `INSERT INTO thread_items (id, thread_id, kind, title, occurred_at, status, memory_entry_id,
                                 source_type, source_ref, created_at)
       VALUES ($1, $2, 'event', $3, $4, 'open', $5, $6, $7, $4)`,
      [itemId, thread.id, cand.summary, now, entryId, cand.sourceType, cand.sourceRef],
    );
  });
  await updateLinkIndex(entryId, thread.scopeId, cand.summary);
  await updateTagIndex(entryId, cand.summary);

  return {
    id: itemId, threadId: thread.id, kind: 'event', title: cand.summary, body: null, occurredAt: now,
    dueAt: null, remindAt: null, status: 'open', nudgeFiredAt: null, firedAt: null, acknowledgedAt: null,
    memoryEntryId: entryId, sourceType: cand.sourceType, sourceRef: cand.sourceRef, createdAt: now,
  };
}

export async function dismissCandidate(thread: Thread, candidateId: string): Promise<void> {
  assertWritable(thread);
  await getPendingCandidate(thread, candidateId);
  const r = await client.execute({
    sql: `UPDATE thread_candidates SET status = 'dismissed'
          WHERE id = ? AND thread_id = ? AND status = 'pending' RETURNING id`,
    args: [candidateId, thread.id],
  });
  if (r.rows.length === 0) throw new ThreadError('INVALID', 'Candidate already handled');
}

export async function closeThread(thread: Thread, input: CloseInput): Promise<Thread> {
  assertWritable(thread);

  // Everything is validated before the first write.
  const open = await client.execute({
    sql: `SELECT * FROM thread_items WHERE thread_id = ? AND status = 'open'`,
    args: [thread.id],
  });
  const openItems = open.rows.map((r) => mapItem(r as Row));
  const byId = new Map(openItems.map((i) => [i.id, i]));
  if (new Set(input.decisions.map((d) => d.itemId)).size !== input.decisions.length) {
    throw new ThreadError('INVALID', 'Duplicate decisions for the same item');
  }
  for (const d of input.decisions) {
    if (!byId.has(d.itemId)) throw new ThreadError('NOT_FOUND', `Open item ${d.itemId} not found in this thread`);
  }

  const successors = new Map<string, Thread>();
  for (const d of input.decisions) {
    if (d.action !== 'carry' || !d.successorThreadId || successors.has(d.successorThreadId)) continue;
    const r = await client.execute({
      sql: `SELECT * FROM threads WHERE id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
      args: [d.successorThreadId, thread.userId],
    });
    if (r.rows.length === 0 || d.successorThreadId === thread.id) {
      throw new ThreadError('SUCCESSOR_INVALID', `Successor thread ${d.successorThreadId} is not an active thread of this user`);
    }
    successors.set(d.successorThreadId, mapThread(r.rows[0] as Row));
  }

  const loops: string[] = [];
  const decisionFor = new Map(input.decisions.map((d) => [d.itemId, d]));
  for (const d of input.decisions) {
    if (d.action === 'carry' && !d.successorThreadId) loops.push(`- [ ] ${byId.get(d.itemId)!.title}`);
  }
  let retro = input.retrospective.replace(/\s+$/, '');
  if (loops.length) retro += `${retro ? '\n\n' : ''}### Open loops\n\n${loops.join('\n')}`;

  const now = new Date().toISOString();
  let content = '';
  await sql.begin(async (tx) => {
    // Transition first: a stale or repeated close gets no row and writes nothing.
    const closing = await tx.unsafe(
      `UPDATE threads SET status = 'closed', closed_at = $1, updated_at = $1
       WHERE id = $2 AND status <> 'closed' RETURNING id`,
      [now, thread.id],
    );
    if (!closing || closing.length === 0) throw new ThreadError('THREAD_CLOSED', 'This thread is closed');
    // Read inside the transaction so a concurrent section edit is not overwritten.
    const root = await tx.unsafe(
      `SELECT content FROM memory_entries WHERE id = $1 AND is_deleted = false LIMIT 1`,
      [thread.rootEntryId],
    );
    if (!root || root.length === 0) throw new ThreadError('NOT_FOUND', 'Thread root entry not found');
    content = applySection((root[0].content as string | null) ?? '', 'Retrospective', retro, 'replace');
    await tx.unsafe(
      `UPDATE memory_entries SET content = $1, version = version + 1, updated_at = $2 WHERE id = $3`,
      [content, now, thread.rootEntryId],
    );
    for (const item of openItems) {
      const d = decisionFor.get(item.id);
      const successor = d?.action === 'carry' && d.successorThreadId ? successors.get(d.successorThreadId) : undefined;
      if (successor) {
        await tx.unsafe(
          `INSERT INTO thread_items (id, thread_id, kind, title, body, occurred_at, due_at, remind_at, status,
                                     memory_entry_id, source_type, source_ref, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10, $11, $12)`,
          [nanoid(), successor.id, item.kind, item.title, item.body, item.occurredAt, item.dueAt,
            item.remindAt, item.memoryEntryId, item.sourceType, item.sourceRef, now],
        );
        const body = `${item.body ? item.body + ' ' : ''}(carried to ${successor.title})`;
        await tx.unsafe(`UPDATE thread_items SET status = 'cancelled', body = $1 WHERE id = $2`, [body, item.id]);
      } else {
        await tx.unsafe(`UPDATE thread_items SET status = 'cancelled' WHERE id = $1`, [item.id]);
      }
    }
  });

  await updateLinkIndex(thread.rootEntryId, thread.scopeId, content);
  await updateTagIndex(thread.rootEntryId, content);
  return { ...thread, status: 'closed', closedAt: now, updatedAt: now };
}
