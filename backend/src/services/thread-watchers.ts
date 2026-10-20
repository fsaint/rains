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
  const account = w.account || undefined;

  // Imported lazily: agent-endpoint imports this module for its pre-approval check.
  const { resolveToolPolicy } = await import('../mcp/agent-endpoint.js');

  const isGmail = w.kind.startsWith('gmail_');
  const serviceType = isGmail ? 'gmail' : 'hermeneutix';
  const serviceName = isGmail ? 'Gmail' : 'Hermeneutix';
  const toolName = isGmail ? GMAIL_READ_TOOL : HX_READ_TOOL;

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
      // A stored row from before the kind set settled; never render it as blank.
      return `watch ${String(w.kind)} ${w.value}`;
  }
}
