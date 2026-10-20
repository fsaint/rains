/**
 * Tests for the /api/threads read and allowed-write routes.
 *
 * The service layer is mocked: what is under test is the route contract —
 * who may call, scope reachability (404, not 403), ThreadError mapping, and
 * the input whitelists a handler must enforce because the service does not.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const svc = vi.hoisted(() => ({
  listThreads: vi.fn(),
  getThread: vi.fn(),
  getThreadBrief: vi.fn(),
  addItem: vi.fn(),
  updateItem: vi.fn(),
  acknowledgeItem: vi.fn(),
  updateSections: vi.fn(),
  setThreadStatus: vi.fn(),
  acceptCandidate: vi.fn(),
  dismissCandidate: vi.fn(),
  listPendingCandidates: vi.fn(),
  listWatchers: vi.fn(),
  listOpenItems: vi.fn(),
  countBadge: vi.fn(),
  mintThread: vi.fn(),
  closeThread: vi.fn(),
}));
const watcherSvc = vi.hoisted(() => ({
  checkWatcherAccess: vi.fn(),
  addWatcher: vi.fn(),
  removeWatcher: vi.fn(),
}));
const { mockResolveAgentContext } = vi.hoisted(() => ({ mockResolveAgentContext: vi.fn() }));
const { mockIsServiceEnabled } = vi.hoisted(() => ({ mockIsServiceEnabled: vi.fn() }));

vi.mock('../services/threads.js', () => {
  class ThreadError extends Error {
    constructor(public code: string, message: string) {
      super(message);
      this.name = 'ThreadError';
    }
  }
  return { ...svc, ThreadError };
});
vi.mock('../services/permissions.js', () => ({ isServiceEnabledForAgent: mockIsServiceEnabled }));
vi.mock('../services/thread-watchers.js', async () => {
  const actual = await vi.importActual<typeof import('../services/thread-watchers.js')>('../services/thread-watchers.js');
  return { ...actual, ...watcherSvc };
});
vi.mock('../services/thread-approved.js', () => ({ resolveAgentContext: mockResolveAgentContext }));

import { registerThreadRoutes } from './thread-routes.js';
import { ThreadError } from '../services/threads.js';

const sessionCtx = {
  userId: 'u1', agentId: null, scopes: [], scopeIds: ['s1'], defaultScopeId: 's1', isSession: true,
};
const agentCtx = { ...sessionCtx, agentId: 'a1', isSession: false };
const thread = { id: 't1', status: 'active', scopeId: 's1' };

describe('thread routes', () => {
  let app: FastifyInstance;
  let ctx: typeof sessionCtx | null;
  let session: { userId: string } | null;

  beforeEach(async () => {
    vi.clearAllMocks();
    ctx = sessionCtx;
    session = { userId: 'u1' };
    mockIsServiceEnabled.mockResolvedValue(true);
    svc.getThread.mockResolvedValue(thread);
    app = Fastify();
    registerThreadRoutes(app, {
      resolveMemoryScopeContext: async () => ctx,
      getSession: () => session,
    });
    await app.ready();
  });

  it('returns 401 when nobody is authenticated', async () => {
    ctx = null;
    const res = await app.inject({ method: 'GET', url: '/api/threads' });
    expect(res.statusCode).toBe(401);
  });

  it("GET /api/threads/:id returns 404 for a thread outside the caller's scopes", async () => {
    svc.getThread.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/api/threads/other' });
    expect(res.statusCode).toBe(404);
    expect(svc.getThread).toHaveBeenCalledWith('other', ['s1']);
  });

  it('agent caller without threads enabled -> 403 SERVICE_NOT_ENABLED', async () => {
    ctx = agentCtx as never;
    session = null;
    mockIsServiceEnabled.mockResolvedValue(false);
    const res = await app.inject({ method: 'GET', url: '/api/threads' });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('SERVICE_NOT_ENABLED');
    expect(mockIsServiceEnabled).toHaveBeenCalledWith('a1', 'threads');
  });

  it('GET /api/threads lists with the status filter', async () => {
    svc.listThreads.mockResolvedValue([thread]);
    const res = await app.inject({ method: 'GET', url: '/api/threads?status=paused' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [thread] });
    expect(svc.listThreads).toHaveBeenCalledWith(['s1'], 'paused');
  });

  describe('GET /api/threads scope filter', () => {
    const multi = {
      ...sessionCtx,
      scopes: [{ id: 's1', slug: 'home' }, { id: 's2', slug: 'work' }],
      scopeIds: ['s1', 's2'],
    };

    beforeEach(() => {
      ctx = multi as never;
      svc.listThreads.mockResolvedValue([thread]);
    });

    it('narrows to the scope named by slug', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/threads?scope=work&status=active' });
      expect(res.statusCode).toBe(200);
      expect(svc.listThreads).toHaveBeenCalledWith(['s2'], 'active');
    });

    it('narrows to the scope named by id', async () => {
      await app.inject({ method: 'GET', url: '/api/threads?scope=s1' });
      expect(svc.listThreads).toHaveBeenCalledWith(['s1'], undefined);
    });

    it('lists every granted scope when scope is absent', async () => {
      await app.inject({ method: 'GET', url: '/api/threads' });
      expect(svc.listThreads).toHaveBeenCalledWith(['s1', 's2'], undefined);
    });

    it('rejects an ungranted scope like the memory routes, listing the valid ones', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/threads?scope=secret' });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('SCOPE_NOT_GRANTED');
      expect(res.json().available_scopes).toEqual(['home', 'work']);
      expect(svc.listThreads).not.toHaveBeenCalled();
    });
  });

  it('GET /api/threads rejects an unknown status filter', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/threads?status=bogus' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID');
  });

  it('POST /api/threads/:id/status with "closed" -> 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/threads/t1/status', payload: { status: 'closed' } });
    expect(res.statusCode).toBe(400);
    expect(svc.setThreadStatus).not.toHaveBeenCalled();
  });

  it('POST /api/threads/:id/status passes paused through', async () => {
    svc.setThreadStatus.mockResolvedValue({ ...thread, status: 'paused' });
    const res = await app.inject({ method: 'POST', url: '/api/threads/t1/status', payload: { status: 'paused' } });
    expect(res.statusCode).toBe(200);
    expect(svc.setThreadStatus).toHaveBeenCalledWith(thread, 'paused');
  });

  it('THREAD_CLOSED from the service maps to 409', async () => {
    svc.addItem.mockRejectedValue(new ThreadError('THREAD_CLOSED', 'closed'));
    const res = await app.inject({ method: 'POST', url: '/api/threads/t1/items', payload: { kind: 'todo', title: 'x' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('THREAD_CLOSED');
  });

  it.each([
    ['SUCCESSOR_INVALID', 400],
    ['INVALID', 400],
    ['NOT_FOUND', 404],
  ])('%s from the service maps to %i', async (code, status) => {
    svc.acknowledgeItem.mockRejectedValue(new ThreadError(code as never, 'nope'));
    const res = await app.inject({ method: 'POST', url: '/api/threads/t1/items/i1/acknowledge' });
    expect(res.statusCode).toBe(status);
    expect(res.json().code).toBe(code);
  });

  it('GET /api/threads/badge requires a session (agent token -> 401)', async () => {
    ctx = agentCtx as never;
    session = null;
    const res = await app.inject({ method: 'GET', url: '/api/threads/badge' });
    expect(res.statusCode).toBe(401);
    expect(svc.countBadge).not.toHaveBeenCalled();
  });

  it('GET /api/threads/badge returns the count for a session', async () => {
    svc.countBadge.mockResolvedValue(3);
    const res = await app.inject({ method: 'GET', url: '/api/threads/badge' });
    expect(res.json()).toEqual({ data: { count: 3 } });
    expect(svc.countBadge).toHaveBeenCalledWith('u1');
  });

  it('POST /api/threads/:id/items passes camelCased body through to addItem', async () => {
    svc.addItem.mockResolvedValue({ id: 'i1' });
    const body = { kind: 'deadline', title: 'File', body: 'b', dueAt: '2026-11-01', remindAt: '2026-10-30' };
    const res = await app.inject({ method: 'POST', url: '/api/threads/t1/items', payload: body });
    expect(res.statusCode).toBe(201);
    expect(svc.addItem).toHaveBeenCalledWith(thread, expect.objectContaining({
      ...body,
      dueAt: new Date(body.dueAt).toISOString(),
      remindAt: new Date(body.remindAt).toISOString(),
    }));
  });

  it('POST /api/threads/:id/items rejects a missing title or bad kind', async () => {
    const a = await app.inject({ method: 'POST', url: '/api/threads/t1/items', payload: { kind: 'todo' } });
    const b = await app.inject({ method: 'POST', url: '/api/threads/t1/items', payload: { kind: 'nope', title: 'x' } });
    expect(a.statusCode).toBe(400);
    expect(b.statusCode).toBe(400);
    expect(svc.addItem).not.toHaveBeenCalled();
  });

  it('POST items normalises a non-ISO date to an ISO string', async () => {
    svc.addItem.mockResolvedValue({ id: 'i1' });
    const res = await app.inject({
      method: 'POST', url: '/api/threads/t1/items',
      payload: { kind: 'todo', title: 'x', dueAt: '2026-10-20 10:00', remindAt: null },
    });
    expect(res.statusCode).toBe(201);
    const input = svc.addItem.mock.calls[0][1];
    expect(input.dueAt).toBe(new Date('2026-10-20 10:00').toISOString());
    expect(input.remindAt).toBeNull();
  });

  it.each([
    ['unparseable dueAt', { dueAt: 'tomorrow' }],
    ['numeric dueAt', { dueAt: 1730000000 }],
    ['unparseable remindAt', { remindAt: 'next friday' }],
    ['unparseable occurredAt', { occurredAt: 'soon' }],
    ['numeric title', { title: 42 }],
    ['numeric body', { body: 5 }],
    ['object sourceRef', { sourceRef: {} }],
    ['numeric memoryEntryId', { memoryEntryId: 7 }],
  ])('POST items rejects %s with 400 INVALID', async (_n, extra) => {
    const res = await app.inject({
      method: 'POST', url: '/api/threads/t1/items', payload: { kind: 'todo', title: 'x', ...extra },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID');
    expect(svc.addItem).not.toHaveBeenCalled();
  });

  it('PATCH item normalises dates and lets null clear them', async () => {
    svc.updateItem.mockResolvedValue({ id: 'i1' });
    const res = await app.inject({
      method: 'PATCH', url: '/api/threads/t1/items/i1',
      payload: { remindAt: '2026-10-20 10:00', dueAt: null },
    });
    expect(res.statusCode).toBe(200);
    expect(svc.updateItem).toHaveBeenCalledWith(thread, 'i1', {
      remindAt: new Date('2026-10-20 10:00').toISOString(),
      dueAt: null,
    });
  });

  it.each([
    ['unparseable remindAt', { remindAt: 'tomorrow' }],
    ['numeric dueAt', { dueAt: 123 }],
    ['numeric body', { body: 123 }],
    ['numeric title', { title: 123 }],
    ['null title', { title: null }],
  ])('PATCH item rejects %s with 400 INVALID', async (_n, payload) => {
    const res = await app.inject({ method: 'PATCH', url: '/api/threads/t1/items/i1', payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID');
    expect(svc.updateItem).not.toHaveBeenCalled();
  });

  it('PATCH item forwards only the patchable fields', async () => {
    svc.updateItem.mockResolvedValue({ id: 'i1' });
    const res = await app.inject({
      method: 'PATCH', url: '/api/threads/t1/items/i1',
      payload: { status: 'done', kind: 'event', threadId: 'evil' },
    });
    expect(res.statusCode).toBe(200);
    expect(svc.updateItem).toHaveBeenCalledWith(thread, 'i1', { status: 'done' });
  });

  it('PUT sections forwards whitelisted keys', async () => {
    svc.updateSections.mockResolvedValue(undefined);
    const edits = { Now: { text: 'n', mode: 'replace' }, Next: { text: 'x', mode: 'append' } };
    const res = await app.inject({ method: 'PUT', url: '/api/threads/t1/sections', payload: edits });
    expect(res.statusCode).toBe(200);
    expect(svc.updateSections).toHaveBeenCalledWith(thread, edits);
  });

  it.each([
    ['Retrospective key', { Retrospective: { text: 'x', mode: 'replace' } }],
    ['arbitrary key', { Secrets: { text: 'x', mode: 'replace' } }],
    ['bad mode', { Now: { text: 'x', mode: 'delete' } }],
    ['missing text', { Now: { mode: 'replace' } }],
    ['empty body', {}],
  ])('PUT sections rejects %s with 400 INVALID', async (_n, payload) => {
    const res = await app.inject({ method: 'PUT', url: '/api/threads/t1/sections', payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID');
    expect(svc.updateSections).not.toHaveBeenCalled();
  });

  describe('GET /api/threads/:id/items', () => {
    it('returns the open items for a session', async () => {
      svc.listOpenItems.mockResolvedValue([{ id: 'i1' }]);
      const res = await app.inject({ method: 'GET', url: '/api/threads/t1/items?status=open' });
      expect(res.json()).toEqual({ data: [{ id: 'i1' }] });
      expect(svc.listOpenItems).toHaveBeenCalledWith('t1');
    });

    it('allows an agent caller with threads enabled', async () => {
      ctx = agentCtx as never;
      svc.listOpenItems.mockResolvedValue([]);
      const res = await app.inject({ method: 'GET', url: '/api/threads/t1/items?status=open' });
      expect(res.statusCode).toBe(200);
    });

    it.each(['', '?status=done', '?status=all'])('rejects %s with 400 INVALID', async (qs) => {
      const res = await app.inject({ method: 'GET', url: `/api/threads/t1/items${qs}` });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID');
      expect(svc.listOpenItems).not.toHaveBeenCalled();
    });

    it('404s for a thread outside the caller scopes', async () => {
      svc.getThread.mockResolvedValue(null);
      const res = await app.inject({ method: 'GET', url: '/api/threads/t1/items?status=open' });
      expect(res.statusCode).toBe(404);
      expect(svc.listOpenItems).not.toHaveBeenCalled();
    });

    it('403s an agent without the threads service', async () => {
      ctx = agentCtx as never;
      mockIsServiceEnabled.mockResolvedValue(false);
      const res = await app.inject({ method: 'GET', url: '/api/threads/t1/items?status=open' });
      expect(res.statusCode).toBe(403);
    });
  });

  it('candidates: list, accept, dismiss', async () => {
    svc.listPendingCandidates.mockResolvedValue([{ id: 'c1' }]);
    svc.acceptCandidate.mockResolvedValue({ id: 'i9' });
    svc.dismissCandidate.mockResolvedValue(undefined);
    const list = await app.inject({ method: 'GET', url: '/api/threads/t1/candidates' });
    expect(list.json()).toEqual({ data: [{ id: 'c1' }] });
    const acc = await app.inject({ method: 'POST', url: '/api/threads/t1/candidates/c1/accept' });
    expect(acc.json()).toEqual({ data: { id: 'i9' } });
    const dis = await app.inject({ method: 'POST', url: '/api/threads/t1/candidates/c1/dismiss' });
    expect(dis.statusCode).toBe(200);
    expect(svc.dismissCandidate).toHaveBeenCalledWith(thread, 'c1');
  });

  it('GET watchers and brief are scoped through getThread / getThreadBrief', async () => {
    svc.listWatchers.mockResolvedValue([{ id: 'w1', kind: 'hx_project', value: 'p1', account: null }]);
    svc.getThreadBrief.mockResolvedValue({ thread });
    const w = await app.inject({ method: 'GET', url: '/api/threads/t1/watchers' });
    expect(w.json()).toEqual({
      data: [{
        id: 'w1', kind: 'hx_project', value: 'p1', account: null,
        description: 'scan Hermeneutix project p1 for new sessions every 15 minutes',
      }],
    });
    expect(svc.listWatchers).toHaveBeenCalledWith('t1');
    const b = await app.inject({ method: 'GET', url: '/api/threads/t1/brief' });
    expect(b.json()).toEqual({ data: { thread } });
    expect(svc.getThreadBrief).toHaveBeenCalledWith('t1', ['s1']);
  });

  it('GET watchers describes each watcher in plain words', async () => {
    svc.listWatchers.mockResolvedValue([
      { id: 'w1', kind: 'gmail_sender', value: 'bob@x.com', account: 'ana@y.com' },
      { id: 'w2', kind: 'gmail_query', value: 'from:vc', account: null },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/threads/t1/watchers' });
    expect(res.json().data.map((w: { description: string }) => w.description)).toEqual([
      'scan ana@y.com for mail from bob@x.com every 15 minutes',
      'scan the default Gmail account for mail matching "from:vc" every 15 minutes',
    ]);
  });

  it('GET brief returns 404 when the brief is null', async () => {
    svc.getThreadBrief.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/api/threads/t1/brief' });
    expect(res.statusCode).toBe(404);
  });
  describe('session-only writes', () => {
    const multi = {
      ...sessionCtx,
      scopes: [{ id: 's1', slug: 'home' }, { id: 's2', slug: 'work' }],
      scopeIds: ['s1', 's2'],
    };
    const asAgent = () => {
      ctx = agentCtx as never;
      session = null;
    };
    const closeBody = {
      retrospective: 'It went well.',
      decisions: [
        { itemId: 'i1', action: 'cancel' },
        { itemId: 'i2', action: 'carry', successorThreadId: 't2' },
      ],
    };
    const watcherBody = { agentId: 'a1', kind: 'gmail_sender', value: 'bob@x.com', account: 'ana@y.com' };

    beforeEach(() => {
      svc.mintThread.mockResolvedValue(thread);
      svc.closeThread.mockResolvedValue({ ...thread, status: 'closed' });
      watcherSvc.checkWatcherAccess.mockResolvedValue({ ok: true });
      watcherSvc.addWatcher.mockResolvedValue({ id: 'w1' });
      watcherSvc.removeWatcher.mockResolvedValue(true);
      mockResolveAgentContext.mockResolvedValue({ ...agentCtx, scopeIds: ['s1'] });
    });

    it('an agent-secret POST /api/threads is refused', async () => {
      asAgent();
      const res = await app.inject({ method: 'POST', url: '/api/threads', payload: { title: 'x', goal: 'g' } });
      expect(res.statusCode).toBe(401);
      expect(svc.mintThread).not.toHaveBeenCalled();
    });

    it('an agent-secret POST /api/threads/:id/close is refused', async () => {
      asAgent();
      const res = await app.inject({ method: 'POST', url: '/api/threads/t1/close', payload: closeBody });
      expect(res.statusCode).toBe(401);
      expect(svc.closeThread).not.toHaveBeenCalled();
    });

    it('agent-secret watcher creation and removal are refused', async () => {
      asAgent();
      const add = await app.inject({ method: 'POST', url: '/api/threads/t1/watchers', payload: watcherBody });
      expect(add.statusCode).toBe(401);
      const del = await app.inject({ method: 'DELETE', url: '/api/threads/t1/watchers/w1' });
      expect(del.statusCode).toBe(401);
      expect(watcherSvc.addWatcher).not.toHaveBeenCalled();
      expect(watcherSvc.removeWatcher).not.toHaveBeenCalled();
    });

    it('a session that resolves to an agent context is still refused', async () => {
      ctx = agentCtx as never;
      const res = await app.inject({ method: 'POST', url: '/api/threads', payload: { title: 'x', goal: 'g' } });
      expect(res.statusCode).toBe(401);
      expect(svc.mintThread).not.toHaveBeenCalled();
    });

    it('session POST /api/threads mints with approvalId null', async () => {
      ctx = multi as never;
      const res = await app.inject({
        method: 'POST', url: '/api/threads',
        payload: { title: 'Seed round', goal: 'Close it', scope: 'work', targetDate: '2026-12-01', now: 'Term sheet' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ data: thread });
      expect(svc.mintThread).toHaveBeenCalledWith({
        userId: 'u1', scopeId: 's2', title: 'Seed round', goal: 'Close it',
        targetDate: '2026-12-01T00:00:00.000Z', past: undefined, now: 'Term sheet', next: undefined,
        approvalId: null, createdByAgentId: null,
      });
    });

    it('session POST /api/threads defaults to the default scope and resolves an id', async () => {
      ctx = multi as never;
      await app.inject({ method: 'POST', url: '/api/threads', payload: { title: 'a' } });
      expect(svc.mintThread).toHaveBeenLastCalledWith(expect.objectContaining({ scopeId: 's1', goal: null }));
      await app.inject({ method: 'POST', url: '/api/threads', payload: { title: 'b', scope: 's2' } });
      expect(svc.mintThread).toHaveBeenLastCalledWith(expect.objectContaining({ scopeId: 's2' }));
    });

    it('session POST /api/threads rejects an unreachable scope with the valid slugs', async () => {
      ctx = multi as never;
      const res = await app.inject({ method: 'POST', url: '/api/threads', payload: { title: 'x', scope: 'secret' } });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('SCOPE_NOT_GRANTED');
      expect(svc.mintThread).not.toHaveBeenCalled();
    });

    it.each([
      ['missing title', { goal: 'g' }],
      ['blank title', { title: '  ' }],
      ['numeric goal', { title: 'x', goal: 3 }],
      ['bad targetDate', { title: 'x', targetDate: 'someday' }],
      ['numeric past', { title: 'x', past: 1 }],
    ])('session POST /api/threads rejects %s with 400 INVALID', async (_n, payload) => {
      const res = await app.inject({ method: 'POST', url: '/api/threads', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID');
      expect(svc.mintThread).not.toHaveBeenCalled();
    });

    it('a duplicate title is a 409', async () => {
      svc.mintThread.mockRejectedValue(new Error('A thread named "x" already exists in this scope'));
      const res = await app.inject({ method: 'POST', url: '/api/threads', payload: { title: 'x' } });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('DUPLICATE');
    });

    it('session close loads the thread in scope and calls closeThread', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/threads/t1/close', payload: closeBody });
      expect(res.statusCode).toBe(200);
      expect(svc.getThread).toHaveBeenCalledWith('t1', ['s1']);
      expect(svc.closeThread).toHaveBeenCalledWith(thread, closeBody);
    });

    it('session close 404s outside the scopes and maps ThreadError', async () => {
      svc.getThread.mockResolvedValueOnce(null);
      const missing = await app.inject({ method: 'POST', url: '/api/threads/other/close', payload: closeBody });
      expect(missing.statusCode).toBe(404);
      svc.closeThread.mockRejectedValue(new ThreadError('SUCCESSOR_INVALID', 'nope'));
      const bad = await app.inject({ method: 'POST', url: '/api/threads/t1/close', payload: closeBody });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().code).toBe('SUCCESSOR_INVALID');
    });

    it.each([
      ['missing retrospective', { decisions: [] }],
      ['decisions not an array', { retrospective: 'r', decisions: 'all' }],
      ['decision without itemId', { retrospective: 'r', decisions: [{ action: 'cancel' }] }],
      ['unknown action', { retrospective: 'r', decisions: [{ itemId: 'i1', action: 'keep' }] }],
      ['numeric successor', { retrospective: 'r', decisions: [{ itemId: 'i1', action: 'carry', successorThreadId: 2 }] }],
    ])('session close rejects %s with 400 INVALID', async (_n, payload) => {
      const res = await app.inject({ method: 'POST', url: '/api/threads/t1/close', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID');
      expect(svc.closeThread).not.toHaveBeenCalled();
    });

    it('session watcher creation checks the agent, its scope and its source access, then adds', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/threads/t1/watchers', payload: watcherBody });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ data: { id: 'w1' } });
      expect(mockResolveAgentContext).toHaveBeenCalledWith('a1', 'u1');
      const w = { kind: 'gmail_sender', value: 'bob@x.com', account: 'ana@y.com' };
      expect(watcherSvc.checkWatcherAccess).toHaveBeenCalledWith('a1', w);
      expect(watcherSvc.addWatcher).toHaveBeenCalledWith('t1', 'a1', w);
    });

    it('session watcher creation needs an agentId the user owns', async () => {
      const missing = await app.inject({ method: 'POST', url: '/api/threads/t1/watchers', payload: { kind: 'hx_project', value: 'p' } });
      expect(missing.statusCode).toBe(400);
      mockResolveAgentContext.mockResolvedValueOnce(null);
      const foreign = await app.inject({ method: 'POST', url: '/api/threads/t1/watchers', payload: watcherBody });
      expect(foreign.statusCode).toBe(404);
      expect(watcherSvc.addWatcher).not.toHaveBeenCalled();
    });

    it('session watcher creation refuses an agent without the thread\'s scope', async () => {
      mockResolveAgentContext.mockResolvedValueOnce({ ...agentCtx, scopeIds: ['s9'] });
      const res = await app.inject({ method: 'POST', url: '/api/threads/t1/watchers', payload: watcherBody });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('SCOPE_NOT_GRANTED');
      expect(watcherSvc.checkWatcherAccess).not.toHaveBeenCalled();
      expect(watcherSvc.addWatcher).not.toHaveBeenCalled();
    });

    it('session watcher creation returns 400 WATCHER_SOURCE_NOT_GRANTED when the agent cannot read the source', async () => {
      watcherSvc.checkWatcherAccess.mockResolvedValueOnce({ ok: false, message: 'WATCHER_SOURCE_NOT_GRANTED: no Gmail.' });
      const res = await app.inject({ method: 'POST', url: '/api/threads/t1/watchers', payload: watcherBody });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'WATCHER_SOURCE_NOT_GRANTED: no Gmail.', code: 'WATCHER_SOURCE_NOT_GRANTED' });
      expect(watcherSvc.addWatcher).not.toHaveBeenCalled();
    });

    it('session watcher creation on a closed thread is a 409', async () => {
      svc.getThread.mockResolvedValueOnce({ ...thread, status: 'closed' });
      const res = await app.inject({ method: 'POST', url: '/api/threads/t1/watchers', payload: watcherBody });
      expect(res.statusCode).toBe(409);
      expect(watcherSvc.addWatcher).not.toHaveBeenCalled();
    });

    it('session DELETE watcher removes only within a visible thread', async () => {
      const ok = await app.inject({ method: 'DELETE', url: '/api/threads/t1/watchers/w1' });
      expect(ok.statusCode).toBe(200);
      expect(watcherSvc.removeWatcher).toHaveBeenCalledWith('t1', 'w1');

      watcherSvc.removeWatcher.mockResolvedValueOnce(false);
      const gone = await app.inject({ method: 'DELETE', url: '/api/threads/t1/watchers/w9' });
      expect(gone.statusCode).toBe(404);

      svc.getThread.mockResolvedValueOnce(null);
      const hidden = await app.inject({ method: 'DELETE', url: '/api/threads/other/watchers/w1' });
      expect(hidden.statusCode).toBe(404);
      expect(watcherSvc.removeWatcher).toHaveBeenCalledTimes(2);
    });
  });
});
