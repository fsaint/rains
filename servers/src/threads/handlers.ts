/**
 * Threads MCP Server Handlers
 *
 * Each handler calls the Reins backend API (/api/threads/*) using the agent's
 * gateway token for authentication.
 *
 * thread_propose, thread_close and thread_add_watcher are not implemented here.
 * They are approval-locked: the backend executes them in-process once the owner
 * approves, so a handler that is reached has been reached without approval.
 */

import type { ServerContext, ToolResult } from '../common/types.js';

function getApiBase(): string {
  return (process.env.REINS_API_URL ?? 'https://app.helm.mom').replace(/\/$/, '');
}

function getGatewayToken(context: ServerContext): string {
  return context.gatewayToken ?? process.env.REINS_GATEWAY_TOKEN ?? '';
}

async function threadsFetch(
  context: ServerContext,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = getGatewayToken(context);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> ?? {}),
  };
  if (token) {
    headers['x-reins-agent-secret'] = token;
  }

  return fetch(`${getApiBase()}${path}`, {
    ...options,
    headers,
  });
}

/**
 * Turn a non-2xx into a message the model can act on. The routes write their
 * refusals (THREAD_CLOSED, INVALID, NOT_FOUND) as sentences; reporting only the
 * status code would throw away the part that lets the model correct itself.
 */
async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null) as
    | { error?: unknown; message?: unknown }
    | null;
  if (!body) return `${fallback} (HTTP ${res.status})`;

  const nested = (body.error as { message?: string } | undefined)?.message;
  const detail =
    nested ??
    (typeof body.message === 'string' ? body.message : undefined) ??
    (typeof body.error === 'string' ? body.error : undefined);
  return detail ?? `${fallback} (HTTP ${res.status})`;
}

async function request<T = unknown>(
  context: ServerContext,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await threadsFetch(context, path, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(await readError(res, `Threads API ${method} ${path} failed`));
  const json = await res.json() as { data: T };
  return json.data;
}

/** Drop undefined so only the fields the model supplied reach the route. */
function defined(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v === '') throw new Error(`${key} is required`);
  return v;
}

const enc = encodeURIComponent;

/** Run a handler body, mapping a thrown Error to a failed ToolResult. */
async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { success: true, data: await fn() };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Brief rendering ───────────────────────────────────────────────────────────

// Declared locally: servers has no dependency on backend. Mirrors ThreadBrief in
// backend/src/services/threads.ts, narrowed to the fields rendered here.
interface BriefItem {
  id: string;
  title: string;
  body?: string | null;
  occurredAt?: string | null;
  dueAt?: string | null;
  remindAt?: string | null;
}

interface BriefCandidate {
  id: string;
  summary?: string;
  sourceType?: string;
  sourceRef?: string;
}

interface BriefData {
  thread: { id: string; title: string; status: string; goal?: string | null; targetDate?: string | null };
  sections?: Record<string, string>;
  events?: BriefItem[];
  openTodos?: BriefItem[];
  upcoming?: BriefItem[];
  firedUnacknowledged?: BriefItem[];
  pendingCandidates?: BriefCandidate[];
  activeCount?: number;
}

const day = (iso?: string | null): string => (iso ? iso.slice(0, 10) : '');

function itemLine(item: BriefItem, when?: string | null): string {
  const date = day(when);
  return `- ${item.title}${date ? ` (${date})` : ''} [${item.id}]`;
}

function group(heading: string, lines: string[]): string[] {
  return lines.length > 0 ? ['', `## ${heading}`, ...lines] : [];
}

/**
 * The brief as text. The order is the order an agent should act in: where the
 * thread stands, then what is due, then what is coming, then what is new.
 * Empty groups are left out rather than printed as "none".
 */
function renderBrief(brief: BriefData): string {
  const { thread, sections = {} } = brief;
  const lines: string[] = [`# ${thread.title} (${thread.status}) [${thread.id}]`];
  if (thread.targetDate) lines.push(`Target date: ${day(thread.targetDate)}`);

  for (const name of ['Goal', 'Past', 'Now', 'Next']) {
    const text = sections[name]?.trim();
    if (text) lines.push('', `## ${name}`, text);
  }

  lines.push(...group('Due now', (brief.firedUnacknowledged ?? []).map((i) => itemLine(i, i.dueAt ?? i.remindAt))));
  lines.push(...group('Upcoming', (brief.upcoming ?? []).map((i) => itemLine(i, i.dueAt ?? i.remindAt))));
  lines.push(...group('Open todos', (brief.openTodos ?? []).map((i) => itemLine(i, i.dueAt))));
  lines.push(...group('Recent events', (brief.events ?? []).map((i) => itemLine(i, i.occurredAt))));
  lines.push(...group('New candidates', (brief.pendingCandidates ?? []).map((c) => {
    const source = [c.sourceType, c.sourceRef].filter(Boolean).join(': ');
    return `- ${c.summary ?? '(no summary)'}${source ? ` (${source})` : ''} [${c.id}]`;
  })));

  return lines.join('\n');
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function handleList(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  return run(async () => {
    const params = new URLSearchParams();
    if (args.status) params.set('status', String(args.status));
    if (args.scope) params.set('scope', String(args.scope));
    const query = params.toString();
    return request(context, 'GET', `/api/threads${query ? `?${query}` : ''}`);
  });
}

export async function handleGetBrief(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  return run(async () => {
    const id = requireString(args, 'thread_id');
    const brief = await request<BriefData>(context, 'GET', `/api/threads/${enc(id)}/brief`);
    return { brief: renderBrief(brief), activeCount: brief.activeCount };
  });
}

export async function handleListCandidates(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  return run(async () => {
    const id = requireString(args, 'thread_id');
    return request(context, 'GET', `/api/threads/${enc(id)}/candidates`);
  });
}

export async function handleLogEvent(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  return run(async () => {
    const id = requireString(args, 'thread_id');
    return request(context, 'POST', `/api/threads/${enc(id)}/items`, defined({
      kind: 'event',
      title: requireString(args, 'title'),
      body: args.body,
      occurredAt: args.occurred_at,
      sourceType: args.source_type,
      sourceRef: args.source_ref,
    }));
  });
}

const ADDABLE_KINDS = ['todo', 'deadline', 'reminder', 'milestone'];

export async function handleAddItem(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  return run(async () => {
    const id = requireString(args, 'thread_id');
    const kind = requireString(args, 'kind');
    if (!ADDABLE_KINDS.includes(kind)) {
      throw new Error(`kind must be one of ${ADDABLE_KINDS.join(', ')}; use thread_log_event for events`);
    }
    return request(context, 'POST', `/api/threads/${enc(id)}/items`, defined({
      kind,
      title: requireString(args, 'title'),
      body: args.body,
      dueAt: args.due_at,
      remindAt: args.remind_at,
    }));
  });
}

export async function handleUpdateItem(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  return run(async () => {
    const id = requireString(args, 'thread_id');
    const itemId = requireString(args, 'item_id');
    const patch = defined({
      title: args.title,
      body: args.body,
      dueAt: args.due_at,
      remindAt: args.remind_at,
      status: args.status,
    });
    if (Object.keys(patch).length === 0) {
      throw new Error('Provide at least one of title, body, due_at, remind_at or status');
    }
    return request(context, 'PATCH', `/api/threads/${enc(id)}/items/${enc(itemId)}`, patch);
  });
}

export async function handleUpdateNow(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  return run(async () => {
    const id = requireString(args, 'thread_id');
    const sections: Record<string, { text: string; mode: 'replace' | 'append' }> = {};
    if (typeof args.now === 'string') sections.Now = { text: args.now, mode: 'replace' };
    if (typeof args.next === 'string') sections.Next = { text: args.next, mode: 'replace' };
    if (typeof args.past_append === 'string') sections.Past = { text: args.past_append, mode: 'append' };
    if (Object.keys(sections).length === 0) {
      throw new Error('Provide at least one of now, next or past_append');
    }
    return request(context, 'PUT', `/api/threads/${enc(id)}/sections`, sections);
  });
}

export async function handleAttachSource(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  return run(async () => {
    const id = requireString(args, 'thread_id');
    return request(context, 'POST', `/api/threads/${enc(id)}/items`, defined({
      kind: 'event',
      title: requireString(args, 'title'),
      sourceType: requireString(args, 'source_type'),
      sourceRef: requireString(args, 'source_ref'),
      memoryEntryId: args.memory_entry_id,
    }));
  });
}

export async function handleAcceptCandidate(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  return run(async () => {
    const id = requireString(args, 'thread_id');
    const cid = requireString(args, 'candidate_id');
    return request(context, 'POST', `/api/threads/${enc(id)}/candidates/${enc(cid)}/accept`);
  });
}

export async function handleDismissCandidate(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  return run(async () => {
    const id = requireString(args, 'thread_id');
    const cid = requireString(args, 'candidate_id');
    return request(context, 'POST', `/api/threads/${enc(id)}/candidates/${enc(cid)}/dismiss`);
  });
}

async function setStatus(
  args: Record<string, unknown>,
  context: ServerContext,
  status: 'active' | 'paused'
): Promise<ToolResult> {
  return run(async () => {
    const id = requireString(args, 'thread_id');
    return request(context, 'POST', `/api/threads/${enc(id)}/status`, { status });
  });
}

export const handlePause = (args: Record<string, unknown>, context: ServerContext) =>
  setStatus(args, context, 'paused');

export const handleResume = (args: Record<string, unknown>, context: ServerContext) =>
  setStatus(args, context, 'active');

// ── Approval-locked tools ─────────────────────────────────────────────────────

function approvalOnly(tool: string) {
  return async (_args: Record<string, unknown>, _context: ServerContext): Promise<ToolResult> => ({
    success: false,
    error: `${tool} runs only through an approved request.`,
  });
}

export const handlePropose = approvalOnly('thread_propose');
export const handleClose = approvalOnly('thread_close');
export const handleAddWatcher = approvalOnly('thread_add_watcher');
