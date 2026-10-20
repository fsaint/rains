/**
 * Approved executors for the three locked thread tools.
 *
 * thread_propose, thread_close and thread_add_watcher never reach the threads
 * MCP server: agent-endpoint holds every call for approval and, once the owner
 * approves, runs it here, in-process, as the calling agent. No REST route
 * accepts agent auth for these writes, so this is the only way an agent's
 * request can mint, close or add a watcher.
 *
 * The approval may land long after the call was made, so everything the call
 * depends on — the agent's owner, its scopes, its watcher access — is read
 * again here rather than trusted from the moment it was raised.
 */

import { client } from '../db/index.js';
import { resolveMemoryContext, pickScope, isRejection, type MemoryContext } from './memory-scopes.js';
import { mintThread, closeThread, getThread, ThreadError, type CloseInput } from './threads.js';
import { checkWatcherAccess, addWatcher, type WatcherInput } from './thread-watchers.js';

export const IN_PROCESS_THREAD_TOOLS: ReadonlySet<string> = new Set([
  'thread_propose',
  'thread_close',
  'thread_add_watcher',
]);

type ApprovedResult = { success: boolean; data?: unknown; isToolError?: boolean };

const toolError = (error: string): ApprovedResult => ({ success: false, isToolError: true, data: { error } });

const isText = (v: unknown) => v === undefined || v === null || typeof v === 'string';

/**
 * The scope context of an active agent, read as that agent. With `ownerId`,
 * also null when the agent belongs to someone else.
 */
export async function resolveAgentContext(agentId: string, ownerId?: string): Promise<MemoryContext | null> {
  const result = await client.execute({
    sql: `SELECT user_id, status FROM agents WHERE id = ? LIMIT 1`,
    args: [agentId],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const userId = row?.user_id as string | null | undefined;
  if (!userId || row?.status !== 'active') return null;
  if (ownerId !== undefined && userId !== ownerId) return null;
  return resolveMemoryContext(null, async () => ({ agentId, userId }));
}

/** Watchers arrive from an agent; checkWatcherAccess validates kind, value and account. */
function readWatcher(w: unknown): WatcherInput | null {
  if (!w || typeof w !== 'object') return null;
  const { kind, value, account } = w as Record<string, unknown>;
  return { kind, value, account } as WatcherInput;
}

async function propose(agentId: string, ctx: MemoryContext, args: Record<string, unknown>, approvalId: string) {
  const { title, goal, past, now, next } = args;
  if (typeof title !== 'string' || title.trim() === '') return toolError('INVALID: title is required.');
  if (!isText(goal) || !isText(past) || !isText(now) || !isText(next)) {
    return toolError('INVALID: goal, past, now and next must be strings.');
  }
  let targetDate: string | null = null;
  if (args.target_date !== undefined && args.target_date !== null) {
    const t = typeof args.target_date === 'string' ? new Date(args.target_date).getTime() : NaN;
    if (Number.isNaN(t)) return toolError('INVALID: target_date must be a valid date.');
    targetDate = new Date(t).toISOString();
  }

  let watchers: WatcherInput[] = [];
  if (args.watchers !== undefined) {
    if (!Array.isArray(args.watchers)) return toolError('INVALID: watchers must be an array.');
    const read = args.watchers.map(readWatcher);
    if (read.some((w) => w === null)) return toolError('INVALID: each watcher must be an object.');
    watchers = read as WatcherInput[];
  }

  const picked = pickScope(ctx, args.scope as string | undefined, 'write');
  if (isRejection(picked)) return toolError(`${picked.body.code}: ${picked.body.error}`);

  let thread;
  try {
    thread = await mintThread({
      userId: ctx.userId,
      scopeId: picked.scopeIds[0],
      title,
      goal: (goal as string | null | undefined) ?? null,
      targetDate,
      past: (past as string | null | undefined) ?? undefined,
      now: (now as string | null | undefined) ?? undefined,
      next: (next as string | null | undefined) ?? undefined,
      approvalId,
      createdByAgentId: agentId,
    });
  } catch (err) {
    return toolError(err instanceof Error ? err.message : 'Could not create the thread.');
  }

  // The thread was what the owner approved; a watcher whose source the agent
  // has since lost is left off and reported, not added.
  const added: Array<{ id: string }> = [];
  const refused: Array<{ kind: unknown; value: unknown; message: string }> = [];
  for (const w of watchers) {
    const check = await checkWatcherAccess(agentId, w);
    if (check.ok) added.push(await addWatcher(thread.id, agentId, w));
    else refused.push({ kind: w.kind, value: w.value, message: check.message });
  }
  return { success: true, data: { thread, watchers: added, refusedWatchers: refused } };
}

async function close(ctx: MemoryContext, args: Record<string, unknown>) {
  if (typeof args.thread_id !== 'string') return toolError('INVALID: thread_id is required.');
  if (typeof args.retrospective !== 'string') return toolError('INVALID: retrospective must be a string.');
  if (!Array.isArray(args.decisions)) return toolError('INVALID: decisions must be an array.');

  const decisions: CloseInput['decisions'] = [];
  for (const raw of args.decisions) {
    const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (typeof d.item_id !== 'string' || (d.action !== 'cancel' && d.action !== 'carry')) {
      return toolError('INVALID: each decision needs an item_id and an action of cancel or carry.');
    }
    if (d.successor_thread_id !== undefined && typeof d.successor_thread_id !== 'string') {
      return toolError('INVALID: successor_thread_id must be a string.');
    }
    decisions.push({
      itemId: d.item_id,
      action: d.action,
      ...(d.successor_thread_id ? { successorThreadId: d.successor_thread_id } : {}),
    });
  }

  const thread = await getThread(args.thread_id, ctx.scopeIds);
  if (!thread) return toolError('NOT_FOUND: Thread not found.');
  // closeThread checks a successor belongs to the owner; the agent may only
  // carry items into a thread it can itself reach.
  for (const d of decisions) {
    if (d.successorThreadId && !(await getThread(d.successorThreadId, ctx.scopeIds))) {
      return toolError(`SUCCESSOR_INVALID: Successor thread ${d.successorThreadId} is not reachable by this agent.`);
    }
  }

  try {
    return { success: true, data: await closeThread(thread, { retrospective: args.retrospective, decisions }) };
  } catch (err) {
    if (err instanceof ThreadError) return toolError(`${err.code}: ${err.message}`);
    throw err;
  }
}

async function addWatcherApproved(agentId: string, ctx: MemoryContext, args: Record<string, unknown>) {
  if (typeof args.thread_id !== 'string') return toolError('INVALID: thread_id is required.');
  const thread = await getThread(args.thread_id, ctx.scopeIds);
  if (!thread) return toolError('NOT_FOUND: Thread not found.');
  if (thread.status === 'closed') return toolError('THREAD_CLOSED: This thread is closed.');

  const w = readWatcher(args) as WatcherInput;
  const check = await checkWatcherAccess(agentId, w);
  if (!check.ok) return toolError(check.message);
  return { success: true, data: await addWatcher(thread.id, agentId, w) };
}

/** Run an approved call to one of IN_PROCESS_THREAD_TOOLS as `agentId`. */
export async function runApprovedThreadTool(
  agentId: string,
  toolName: string,
  args: Record<string, unknown>,
  approvalId: string,
): Promise<ApprovedResult> {
  if (!IN_PROCESS_THREAD_TOOLS.has(toolName)) return toolError(`${toolName} does not run in-process.`);

  const ctx = await resolveAgentContext(agentId);
  if (!ctx) return toolError('This agent is no longer active, so the approved request was not carried out.');

  switch (toolName) {
    case 'thread_propose':
      return propose(agentId, ctx, args, approvalId);
    case 'thread_close':
      return close(ctx, args);
    default:
      return addWatcherApproved(agentId, ctx, args);
  }
}
