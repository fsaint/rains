/**
 * Thread Watchers
 *
 * A watcher scans one source for things that might belong to a thread and
 * files them as candidates. It runs as its creating agent, and its reach is
 * bounded by that agent's own: it may only cover a source the agent can
 * already read without approval — its Gmail account, its pinned Hermeneutix
 * project. checkWatcherAccess is that bound; it runs before the approval is
 * raised, again in the executor, and before every sweep.
 */

import { nanoid } from 'nanoid';
import { client } from '../db/index.js';
import { getInstanceConfig } from './permissions.js';

export type WatcherKind = 'gmail_thread' | 'gmail_query' | 'gmail_sender' | 'hx_project' | 'hx_meeting';

export const WATCHER_KINDS: readonly WatcherKind[] = [
  'gmail_thread', 'gmail_query', 'gmail_sender', 'hx_project', 'hx_meeting',
];

export interface WatcherInput {
  kind: WatcherKind;
  value: string;
  account?: string | null;
}

/** The read tool each source's sweep calls; the agent must hold it at `allow`. */
const GMAIL_READ_TOOL = 'gmail_search';
const HX_READ_TOOL = 'hermeneutix_list_sessions';

/**
 * Kind-specific shape of the value. It is spliced into a Gmail query, so a
 * sender or thread id must not be able to carry operators of its own. A
 * gmail_query is the owner's approved text and is bounded by parentheses
 * instead (see readCall).
 */
function valueProblem(kind: WatcherKind, value: string): string | null {
  if (kind === 'gmail_sender' && !/^[A-Za-z0-9._%+\-@]+$/.test(value)) {
    return 'a sender must be a single address or domain, with no spaces, quotes, parentheses or operators.';
  }
  if (kind === 'gmail_thread' && !/^[A-Za-z0-9]+$/.test(value)) {
    return 'a Gmail thread id is letters and digits only.';
  }
  return null;
}

const refuse = (message: string) => ({ ok: false as const, message: `WATCHER_SOURCE_NOT_GRANTED: ${message}` });

/**
 * Can this agent's watcher cover `w`? Permission is resolved by the same code
 * tools/call uses (resolveToolPolicy), so the answer cannot drift from what the
 * agent could read by calling the tool itself.
 */
export async function checkWatcherAccess(
  agentId: string,
  w: WatcherInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  // Arguments arrive from an agent; nothing about their shape is trusted.
  if (!WATCHER_KINDS.includes(w.kind)) {
    return refuse(`kind must be one of ${WATCHER_KINDS.join(', ')}.`);
  }
  if (typeof w.value !== 'string' || !w.value.trim()) {
    return refuse('value must be a non-empty string.');
  }
  if (w.account != null && typeof w.account !== 'string') {
    return refuse('account must be a string.');
  }
  const problem = valueProblem(w.kind, w.value);
  if (problem) return refuse(problem);
  const account = w.account || undefined;

  // Imported lazily: agent-endpoint imports this module for its pre-approval check.
  const { resolveToolPolicy } = await import('../mcp/agent-endpoint.js');

  const isGmail = w.kind.startsWith('gmail_');
  const serviceType = isGmail ? 'gmail' : 'hermeneutix';
  const serviceName = isGmail ? 'Gmail' : 'Hermeneutix';
  const toolName = isGmail ? GMAIL_READ_TOOL : HX_READ_TOOL;

  // With no account this resolves the default instance. An agent with several
  // hermeneutix instances can only watch the default one's pinned project.
  const policy = await resolveToolPolicy(agentId, serviceType, toolName, account ? { account } : {});
  if ('error' in policy) {
    return refuse(
      account
        ? `this agent does not hold the ${serviceName} account ${account}.`
        : `this agent does not have ${serviceName} enabled.`
    );
  }
  // The legacy access row has no accounts, so it cannot vouch for a named one.
  if (account && !policy.hasInstances) {
    return refuse(`this agent does not hold the ${serviceName} account ${account}.`);
  }
  if (!policy.allowed || policy.requiresApproval) {
    return refuse(`a watcher needs ${toolName} set to allow for this agent; it is not.`);
  }

  if (isGmail) return { ok: true };

  // Hermeneutix: the watcher is bounded by the instance's pinned project.
  const config = policy.policyInstance ? (await getInstanceConfig(policy.policyInstance.id))?.config : null;
  const pinned = config?.projectId;
  if (typeof pinned !== 'string' || !pinned) {
    return refuse('this agent has no Hermeneutix project pinned, so it cannot watch one.');
  }
  // A meeting id cannot be checked against the pin here; the sweep's tool
  // call fails closed when the meeting is outside it.
  if (w.kind === 'hx_project' && w.value !== pinned) {
    return refuse(`this agent can only watch its pinned Hermeneutix project, not ${w.value}.`);
  }
  return { ok: true };
}

/** Insert an active watcher. Callers run checkWatcherAccess first. */
export async function addWatcher(threadId: string, agentId: string, w: WatcherInput): Promise<{ id: string }> {
  const id = nanoid();
  await client.execute({
    sql: `INSERT INTO thread_watchers (id, thread_id, agent_id, kind, value, account, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
    args: [id, threadId, agentId, w.kind, w.value, w.account ?? null, new Date().toISOString()],
  });
  return { id };
}

/** Delete a watcher of `threadId`; false when that thread has no such watcher. */
export async function removeWatcher(threadId: string, watcherId: string): Promise<boolean> {
  const result = await client.execute({
    sql: `DELETE FROM thread_watchers WHERE id = ? AND thread_id = ? RETURNING id`,
    args: [watcherId, threadId],
  });
  return result.rows.length > 0;
}

/** What the watcher will scan, in plain words — the approval message shows this. */
export function describeWatcher(w: WatcherInput): string {
  const inbox = w.account || 'the default Gmail account';
  switch (w.kind) {
    case 'gmail_sender':
      return `scan ${inbox} for mail from ${w.value} every 15 minutes`;
    case 'gmail_query':
      return `scan ${inbox} for mail matching "${w.value}" every 15 minutes`;
    case 'gmail_thread':
      return `scan ${inbox} for new messages in Gmail thread ${w.value} every 15 minutes`;
    case 'hx_project':
      return `scan Hermeneutix project ${w.value} for new sessions every 15 minutes`;
    case 'hx_meeting':
      return `scan Hermeneutix meeting ${w.value} for new sessions every 15 minutes`;
    default:
      // Unreachable under WatcherKind; guards a stored row whose kind is not
      // one of the five, so it never renders as blank.
      return `watch ${String(w.kind)} ${w.value}`;
  }
}

const GMAIL_MAX_RESULTS = 50;
// Gmail can index a message after the sweep that should have seen it, so each
// gmail sweep reaches back this far past the last one. The unique
// (thread_id, source_ref) index makes the overlap free.
const GMAIL_LAG_MARGIN_MS = 15 * 60 * 1000;
const MAX_PAGES = 5;

interface SweepWatcher {
  id: string;
  thread_id: string;
  agent_id: string;
  kind: WatcherKind;
  value: string;
  account: string | null;
  last_checked_at: string | null;
  created_at: string;
}

interface Candidate {
  sourceType: 'gmail' | 'hermeneutix';
  sourceRef: string;
  summary: string;
}

const asRecords = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];

/** What a watcher's read returned that is new since `since`, as candidates. */
function toCandidates(w: SweepWatcher, data: unknown, since: Date): Candidate[] {
  const body = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;

  if (w.kind.startsWith('gmail_')) {
    let messages = asRecords(body.results);
    if (w.kind === 'gmail_thread') messages = messages.filter((m) => m.threadId === w.value);
    return messages
      .filter((m) => typeof m.id === 'string' && m.id)
      .map((m) => ({
        sourceType: 'gmail' as const,
        sourceRef: `gmail:${m.id}`,
        summary: `${m.from || 'Unknown sender'} — ${m.subject || '(no subject)'}`,
      }));
  }

  // Hermeneutix exposes only started_at, and a session is listed after its
  // meeting is processed, so `since` here is the watcher's creation, never the
  // last sweep. The unique index keeps already-filed sessions from repeating.
  // A session with no start time cannot be placed, so it is skipped.
  return asRecords(body.sessions)
    .filter((s) => typeof s.id === 'string' && s.id)
    .filter((s) => {
      const started = typeof s.started_at === 'string' ? new Date(s.started_at).getTime() : NaN;
      return started > since.getTime();
    })
    .map((s) => ({
      sourceType: 'hermeneutix' as const,
      sourceRef: `hx:${s.id}`,
      summary: (typeof s.title === 'string' && s.title) || String(s.id),
    }));
}

function readCall(w: SweepWatcher, since: Date): { tool: string; args: Record<string, unknown> } {
  const afterSeconds = Math.floor(since.getTime() / 1000);
  const account = w.account ? { account: w.account } : {};
  switch (w.kind) {
    case 'gmail_sender':
      return { tool: GMAIL_READ_TOOL, args: { query: `from:"${w.value}" after:${afterSeconds}`, maxResults: GMAIL_MAX_RESULTS, ...account } };
    case 'gmail_query':
      return { tool: GMAIL_READ_TOOL, args: { query: `(${w.value}) after:${afterSeconds}`, maxResults: GMAIL_MAX_RESULTS, ...account } };
    case 'gmail_thread':
      return { tool: GMAIL_READ_TOOL, args: { query: `after:${afterSeconds}`, maxResults: GMAIL_MAX_RESULTS, ...account } };
    case 'hx_project':
      return { tool: HX_READ_TOOL, args: { project_id: w.value } };
    case 'hx_meeting':
      return { tool: HX_READ_TOOL, args: { instance_id: w.value } };
  }
}

async function suspendWatcher(id: string): Promise<void> {
  await client.execute({ sql: `UPDATE thread_watchers SET status = 'suspended' WHERE id = ?`, args: [id] });
}

/**
 * Run every active watcher on an active thread as its agent and file what is
 * new as candidates. A watcher whose agent can no longer read its source is
 * suspended; a transient failure (inactive agent, lapsed billing, tool or
 * transport error) skips the watcher for this sweep and leaves
 * last_checked_at where it was, so nothing in the gap is missed. One watcher
 * failing never stops the others.
 */
export async function runWatcherSweep(
  now: Date = new Date(),
): Promise<{ checked: number; found: number; suspended: number }> {
  const { runAgentReadTool } = await import('../mcp/agent-endpoint.js');

  const result = await client.execute({
    sql: `SELECT w.id, w.thread_id, w.agent_id, w.kind, w.value, w.account, w.last_checked_at, w.created_at
          FROM thread_watchers w
          JOIN threads t ON t.id = w.thread_id
          WHERE w.status = 'active' AND t.status = 'active'`,
    args: [],
  });

  let checked = 0;
  let found = 0;
  let suspended = 0;

  for (const w of result.rows as unknown as SweepWatcher[]) {
    try {
      const access = await checkWatcherAccess(w.agent_id, w);
      if (!access.ok) {
        await suspendWatcher(w.id);
        suspended++;
        continue;
      }

      checked++;
      const isGmail = w.kind.startsWith('gmail_');
      const created = new Date(w.created_at).getTime();
      const since = new Date(isGmail && w.last_checked_at
        ? Math.max(created, new Date(w.last_checked_at).getTime() - GMAIL_LAG_MARGIN_MS)
        : created);
      const { tool, args } = readCall(w, since);

      // Only the project listing pages. Gmail search and the instance listing
      // return one capped page, so a full page is warned about and accepted.
      const pages: unknown[] = [];
      const auditContext = { watcherId: w.id, threadId: w.thread_id };
      let read = await runAgentReadTool(w.agent_id, tool, args, auditContext);
      let failed = false;
      for (let page = 1; ; page++) {
        if (!read.ok) {
          if (read.reason !== 'error') {
            await suspendWatcher(w.id);
            suspended++;
          }
          failed = true;
          break;
        }
        pages.push(read.data);
        if (w.kind !== 'hx_project') break;
        const hasNext = (read.data as { pagination?: { has_next?: unknown } } | null)?.pagination?.has_next === true;
        if (!hasNext) break;
        if (page >= MAX_PAGES) {
          console.warn(`[thread-watchers] watcher ${w.id} has more than ${MAX_PAGES} pages; later sessions skipped`);
          break;
        }
        read = await runAgentReadTool(w.agent_id, tool, { ...args, page: page + 1 }, auditContext);
      }
      if (failed) continue;

      if (isGmail) {
        const count = asRecords((pages[0] as { results?: unknown } | null)?.results).length;
        if (count >= GMAIL_MAX_RESULTS) {
          console.warn(`[thread-watchers] watcher ${w.id} hit the ${GMAIL_MAX_RESULTS}-result cap; older matches in this window are skipped`);
        }
      }

      for (const c of pages.flatMap((data) => toCandidates(w, data, since))) {
        const inserted = await client.execute({
          sql: `INSERT INTO thread_candidates (id, thread_id, watcher_id, source_type, source_ref, summary, found_at, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
                ON CONFLICT (thread_id, source_ref) DO NOTHING`,
          args: [nanoid(), w.thread_id, w.id, c.sourceType, c.sourceRef, c.summary, now.toISOString()],
        });
        found += inserted.rowsAffected;
      }

      await client.execute({
        sql: `UPDATE thread_watchers SET last_checked_at = ? WHERE id = ?`,
        args: [now.toISOString(), w.id],
      });
    } catch (err) {
      console.warn(`[thread-watchers] watcher ${w.id} failed:`, err instanceof Error ? err.message : err);
    }
  }

  return { checked, found, suspended };
}
