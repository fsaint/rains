/**
 * Threads Service
 *
 * A thread is a time-bound focus topic. Its narrative is an ordinary memory
 * entry (the root); the tables in db/index.ts hold the timeline, watchers and
 * candidates around it. This module covers minting and reading.
 */

import { nanoid } from 'nanoid';
import { client } from '../db/index.js';
import { resolveOrCreate, setEntryParent, ensureMemoryRoot, splitSections } from './memory.js';

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

  const { row, created } = await resolveOrCreate({
    userId,
    scopeId,
    type: 'thread',
    title,
    content: renderRootContent({ goal, past: input.past, now: input.now, next: input.next }),
  });
  if (!created) throw new Error(`A thread named "${title}" already exists in this scope`);

  // Same branch row POST /api/memory/entries writes; setEntryParent only
  // updates an existing one.
  await client.execute({
    sql: `INSERT INTO memory_branches (id, entry_id, parent_entry_id, scope_id, position, is_expanded)
          VALUES (?, ?, NULL, ?, 0, false)`,
    args: [nanoid(), row.id, scopeId],
  });
  const parent = await setEntryParent(row.id, [scopeId], await ensureMemoryRoot(userId, scopeId));
  if ('error' in parent) throw new Error(parent.error);

  const id = nanoid();
  const now = new Date().toISOString();
  await client.execute({
    sql: `INSERT INTO threads (id, user_id, scope_id, root_entry_id, title, goal, target_date, status,
                               approval_id, created_by_agent_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    args: [id, userId, scopeId, row.id, title, goal, targetDate,
      input.approvalId ?? null, input.createdByAgentId ?? null, now, now],
  });

  return {
    id, userId, scopeId, rootEntryId: row.id, title, goal, targetDate, status: 'active',
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
