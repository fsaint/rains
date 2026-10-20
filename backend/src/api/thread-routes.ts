/**
 * /api/threads — reads and the writes a dashboard or an agent may make.
 *
 * Session-only routes (mint, close, watchers) are not here: they are the
 * writes an agent must never reach without the owner's approval.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { MemoryContext } from '../services/memory-scopes.js';
import { isServiceEnabledForAgent } from '../services/permissions.js';
import {
  ThreadError,
  listThreads,
  getThread,
  getThreadBrief,
  addItem,
  updateItem,
  acknowledgeItem,
  updateSections,
  setThreadStatus,
  acceptCandidate,
  dismissCandidate,
  listPendingCandidates,
  listWatchers,
  countBadge,
  type Thread,
  type ThreadStatus,
} from '../services/threads.js';

export interface ThreadRouteDeps {
  resolveMemoryScopeContext(req: any): Promise<MemoryContext | null>;
  getSession(req: any): { userId: string } | null | undefined;
}

const ERROR_STATUS: Record<ThreadError['code'], number> = {
  THREAD_CLOSED: 409,
  SUCCESSOR_INVALID: 400,
  INVALID: 400,
  NOT_FOUND: 404,
};

const ITEM_KINDS = ['event', 'todo', 'deadline', 'reminder', 'milestone'];
const ITEM_STATUSES = ['open', 'done', 'cancelled'];
const SOURCE_TYPES = ['gmail', 'hermeneutix', 'memory', 'manual'];
const LIST_STATUSES = ['active', 'paused', 'closed'];
// Retrospective is written only by close.
const EDITABLE_SECTIONS = ['Goal', 'Past', 'Now', 'Next'];

const invalid = (reply: FastifyReply, error: string) =>
  reply.status(400).send({ error, code: 'INVALID' });

type Parsed = { value: string | null | undefined } | { error: string };

/** undefined -> left out, null -> null, string -> itself; anything else is a 400. */
const parseText = (v: unknown, field: string): Parsed =>
  v === undefined || v === null || typeof v === 'string'
    ? { value: v }
    : { error: `${field} must be a string or null` };

/**
 * Timestamps are compared as ISO text by the scheduler, so a free-form string
 * would sort wrongly and never fire. Normalise to toISOString() or refuse.
 */
const parseDate = (v: unknown, field: string): Parsed => {
  if (v === undefined || v === null) return { value: v };
  const t = typeof v === 'string' ? new Date(v).getTime() : NaN;
  return Number.isNaN(t) ? { error: `${field} must be a valid date` } : { value: new Date(t).toISOString() };
};

/** Parse several fields at once; the first failure wins. */
function parseFields(
  b: Record<string, unknown>,
  spec: Record<string, (v: unknown, field: string) => Parsed>
): { values: Record<string, string | null | undefined> } | { error: string } {
  const values: Record<string, string | null | undefined> = {};
  for (const [field, parse] of Object.entries(spec)) {
    const r = parse(b[field], field);
    if ('error' in r) return r;
    values[field] = r.value;
  }
  return { values };
}

export function registerThreadRoutes(app: FastifyInstance, deps: ThreadRouteDeps): void {
  /** Authenticate, and require the threads service when the caller is an agent. */
  async function authenticate(request: any, reply: FastifyReply): Promise<MemoryContext | null> {
    const memCtx = await deps.resolveMemoryScopeContext(request);
    if (!memCtx) {
      reply.status(401).send({ error: 'Unauthorized' });
      return null;
    }
    if (memCtx.agentId && !(await isServiceEnabledForAgent(memCtx.agentId, 'threads'))) {
      reply.status(403).send({ error: 'The threads service is not enabled for this agent.', code: 'SERVICE_NOT_ENABLED' });
      return null;
    }
    return memCtx;
  }

  /** Authenticate and load the thread, 404 when it is outside the caller's scopes. */
  async function loadThread(
    request: any,
    reply: FastifyReply
  ): Promise<{ memCtx: MemoryContext; thread: Thread } | null> {
    const memCtx = await authenticate(request, reply);
    if (!memCtx) return null;
    const thread = await getThread(request.params.id, memCtx.scopeIds);
    if (!thread) {
      reply.status(404).send({ error: 'Thread not found', code: 'NOT_FOUND' });
      return null;
    }
    return { memCtx, thread };
  }

  /** Run a service call, mapping ThreadError to its HTTP status. */
  async function guarded(reply: FastifyReply, fn: () => Promise<unknown>, status = 200) {
    try {
      return reply.status(status).send({ data: await fn() });
    } catch (err) {
      if (err instanceof ThreadError) {
        return reply.status(ERROR_STATUS[err.code] ?? 400).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  }

  app.get('/api/threads', async (request, reply) => {
    const memCtx = await authenticate(request, reply);
    if (!memCtx) return;
    const status = (request.query as Record<string, string>).status;
    if (status !== undefined && !LIST_STATUSES.includes(status)) return invalid(reply, 'Unknown status');
    return reply.send({ data: await listThreads(memCtx.scopeIds, status as ThreadStatus | undefined) });
  });

  // Session only: the badge is a dashboard affordance, not something an agent reads.
  app.get('/api/threads/badge', async (request, reply) => {
    const session = deps.getSession(request);
    if (!session) return reply.status(401).send({ error: 'Unauthorized' });
    return reply.send({ data: { count: await countBadge(session.userId) } });
  });

  app.get<{ Params: { id: string } }>('/api/threads/:id', async (request, reply) => {
    const loaded = await loadThread(request, reply);
    if (!loaded) return;
    return reply.send({ data: loaded.thread });
  });

  app.get<{ Params: { id: string } }>('/api/threads/:id/brief', async (request, reply) => {
    const loaded = await loadThread(request, reply);
    if (!loaded) return;
    const brief = await getThreadBrief(loaded.thread.id, loaded.memCtx.scopeIds);
    if (!brief) return reply.status(404).send({ error: 'Thread not found', code: 'NOT_FOUND' });
    return reply.send({ data: brief });
  });

  app.post<{ Params: { id: string } }>('/api/threads/:id/items', async (request, reply) => {
    const loaded = await loadThread(request, reply);
    if (!loaded) return;
    const b = (request.body ?? {}) as Record<string, unknown>;
    if (typeof b.kind !== 'string' || !ITEM_KINDS.includes(b.kind)) return invalid(reply, 'kind is invalid');
    if (typeof b.title !== 'string' || b.title.trim() === '') return invalid(reply, 'title is required');
    if (b.sourceType != null && !SOURCE_TYPES.includes(b.sourceType as string)) {
      return invalid(reply, 'sourceType is invalid');
    }
    const parsed = parseFields(b, {
      body: parseText, sourceRef: parseText, memoryEntryId: parseText,
      occurredAt: parseDate, dueAt: parseDate, remindAt: parseDate,
    });
    if ('error' in parsed) return invalid(reply, parsed.error);
    return guarded(
      reply,
      () => addItem(loaded.thread, { kind: b.kind as never, title: b.title as string, sourceType: b.sourceType as never, ...parsed.values }),
      201
    );
  });

  app.patch<{ Params: { id: string; itemId: string } }>(
    '/api/threads/:id/items/:itemId',
    async (request, reply) => {
      const loaded = await loadThread(request, reply);
      if (!loaded) return;
      const b = (request.body ?? {}) as Record<string, unknown>;
      if (b.status !== undefined && !ITEM_STATUSES.includes(b.status as string)) {
        return invalid(reply, 'status is invalid');
      }
      if (b.title !== undefined && (typeof b.title !== 'string' || b.title.trim() === '')) {
        return invalid(reply, 'title must be a non-empty string');
      }
      const parsed = parseFields(b, { body: parseText, dueAt: parseDate, remindAt: parseDate });
      if ('error' in parsed) return invalid(reply, parsed.error);
      const patch: Record<string, unknown> = {};
      if (b.title !== undefined) patch.title = b.title;
      if (b.status !== undefined) patch.status = b.status;
      for (const [key, v] of Object.entries(parsed.values)) {
        if (v !== undefined) patch[key] = v;
      }
      return guarded(reply, () => updateItem(loaded.thread, request.params.itemId, patch as never));
    }
  );

  app.post<{ Params: { id: string; itemId: string } }>(
    '/api/threads/:id/items/:itemId/acknowledge',
    async (request, reply) => {
      const loaded = await loadThread(request, reply);
      if (!loaded) return;
      return guarded(reply, async () => {
        await acknowledgeItem(loaded.thread, request.params.itemId);
        return { acknowledged: true };
      });
    }
  );

  app.put<{ Params: { id: string } }>('/api/threads/:id/sections', async (request, reply) => {
    const loaded = await loadThread(request, reply);
    if (!loaded) return;
    const b = (request.body ?? {}) as Record<string, unknown>;
    const keys = Object.keys(b);
    if (keys.length === 0) return invalid(reply, 'No sections to update');
    for (const key of keys) {
      const e = b[key] as { text?: unknown; mode?: unknown } | null;
      if (!EDITABLE_SECTIONS.includes(key)) return invalid(reply, `Section "${key}" cannot be edited`);
      if (!e || typeof e.text !== 'string' || (e.mode !== 'replace' && e.mode !== 'append')) {
        return invalid(reply, `Section "${key}" needs text and a mode of replace or append`);
      }
    }
    return guarded(reply, async () => {
      await updateSections(loaded.thread, b as never);
      return { updated: keys };
    });
  });

  app.post<{ Params: { id: string } }>('/api/threads/:id/status', async (request, reply) => {
    const loaded = await loadThread(request, reply);
    if (!loaded) return;
    const status = ((request.body ?? {}) as { status?: unknown }).status;
    if (status !== 'active' && status !== 'paused') {
      return invalid(reply, 'status must be active or paused; closing a thread is a separate, approved action');
    }
    return guarded(reply, () => setThreadStatus(loaded.thread, status));
  });

  app.get<{ Params: { id: string } }>('/api/threads/:id/candidates', async (request, reply) => {
    const loaded = await loadThread(request, reply);
    if (!loaded) return;
    return reply.send({ data: await listPendingCandidates(loaded.thread.id) });
  });

  app.post<{ Params: { id: string; cid: string } }>(
    '/api/threads/:id/candidates/:cid/accept',
    async (request, reply) => {
      const loaded = await loadThread(request, reply);
      if (!loaded) return;
      return guarded(reply, () => acceptCandidate(loaded.thread, request.params.cid));
    }
  );

  app.post<{ Params: { id: string; cid: string } }>(
    '/api/threads/:id/candidates/:cid/dismiss',
    async (request, reply) => {
      const loaded = await loadThread(request, reply);
      if (!loaded) return;
      return guarded(reply, async () => {
        await dismissCandidate(loaded.thread, request.params.cid);
        return { dismissed: true };
      });
    }
  );

  app.get<{ Params: { id: string } }>('/api/threads/:id/watchers', async (request, reply) => {
    const loaded = await loadThread(request, reply);
    if (!loaded) return;
    return reply.send({ data: await listWatchers(loaded.thread.id) });
  });
}
