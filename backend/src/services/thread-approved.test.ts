/**
 * Tests for the approved executors of the three locked thread tools.
 *
 * The service layer is mocked; what is under test is that an approved call
 * acts only within the agent's own scopes and re-checks watcher access at
 * execution, since the approval may land long after the request was raised.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const svc = vi.hoisted(() => ({
  mintThread: vi.fn(),
  closeThread: vi.fn(),
  getThread: vi.fn(),
}));
const watchers = vi.hoisted(() => ({
  checkWatcherAccess: vi.fn(),
  addWatcher: vi.fn(),
}));
const { mockResolveMemoryContext, mockExecute } = vi.hoisted(() => ({
  mockResolveMemoryContext: vi.fn(),
  mockExecute: vi.fn(),
}));

vi.mock('../db/index.js', () => ({ client: { execute: mockExecute } }));
vi.mock('./threads.js', () => {
  class ThreadError extends Error {
    constructor(public code: string, message: string) {
      super(message);
      this.name = 'ThreadError';
    }
  }
  return { ...svc, ThreadError };
});
vi.mock('./thread-watchers.js', () => watchers);
vi.mock('./memory-scopes.js', async () => {
  const actual = await vi.importActual<typeof import('./memory-scopes.js')>('./memory-scopes.js');
  return { ...actual, resolveMemoryContext: mockResolveMemoryContext };
});

import { runApprovedThreadTool, IN_PROCESS_THREAD_TOOLS } from './thread-approved.js';
import { ThreadError } from './threads.js';

const agentCtx = {
  userId: 'u1',
  agentId: 'a1',
  scopes: [
    { id: 's1', slug: 'home', name: 'Home', description: null, isDefault: true, archivedAt: null },
    { id: 's2', slug: 'work', name: 'Work', description: null, isDefault: false, archivedAt: null },
  ],
  scopeIds: ['s1', 's2'],
  defaultScopeId: 's1',
  isSession: false,
};
const thread = { id: 't1', userId: 'u1', scopeId: 's2', status: 'active', title: 'Seed round' };

describe('runApprovedThreadTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue({ rows: [{ user_id: 'u1', status: 'active' }] });
    mockResolveMemoryContext.mockResolvedValue(agentCtx);
    svc.mintThread.mockResolvedValue(thread);
    svc.closeThread.mockResolvedValue({ ...thread, status: 'closed' });
    svc.getThread.mockResolvedValue(thread);
    watchers.checkWatcherAccess.mockResolvedValue({ ok: true });
    watchers.addWatcher.mockResolvedValue({ id: 'w1' });
  });

  it('covers exactly the three locked tools', () => {
    expect([...IN_PROCESS_THREAD_TOOLS].sort()).toEqual(['thread_add_watcher', 'thread_close', 'thread_propose']);
  });

  it('resolves the agent\'s scopes through resolveMemoryContext as the agent', async () => {
    await runApprovedThreadTool('a1', 'thread_propose', { title: 'Seed round', goal: 'Close it' }, 'ap-1');
    expect(mockResolveMemoryContext).toHaveBeenCalledWith(null, expect.any(Function));
    const resolveAgent = mockResolveMemoryContext.mock.calls[0][1] as () => Promise<unknown>;
    await expect(resolveAgent()).resolves.toEqual({ agentId: 'a1', userId: 'u1' });
  });

  it('runs nothing for an agent that no longer exists or is not active', async () => {
    for (const rows of [[], [{ user_id: 'u1', status: 'suspended' }], [{ user_id: null, status: 'active' }]]) {
      mockExecute.mockResolvedValueOnce({ rows });
      const res = await runApprovedThreadTool('a1', 'thread_propose', { title: 'Seed round', goal: 'g' }, 'ap-1');
      expect(res.success).toBe(false);
      expect(res.isToolError).toBe(true);
    }
    expect(svc.mintThread).not.toHaveBeenCalled();
  });

  it('refuses a tool it does not run', async () => {
    const res = await runApprovedThreadTool('a1', 'thread_log_event', {}, 'ap-1');
    expect(res).toMatchObject({ success: false, isToolError: true });
  });

  describe('thread_propose', () => {
    it('thread_propose mints in the agent\'s requested scope with approvalId and createdByAgentId', async () => {
      const res = await runApprovedThreadTool('a1', 'thread_propose', {
        title: 'Seed round', goal: 'Close the round', scope: 'work',
        target_date: '2026-12-01', past: 'Met VCs', now: 'Term sheet', next: 'Sign',
      }, 'ap-1');

      expect(svc.mintThread).toHaveBeenCalledWith({
        userId: 'u1', scopeId: 's2', title: 'Seed round', goal: 'Close the round',
        targetDate: '2026-12-01T00:00:00.000Z', past: 'Met VCs', now: 'Term sheet', next: 'Sign',
        approvalId: 'ap-1', createdByAgentId: 'a1',
      });
      expect(res).toEqual({ success: true, data: { thread, watchers: [], refusedWatchers: [] } });
    });

    it('mints in the agent\'s default scope when none is named', async () => {
      await runApprovedThreadTool('a1', 'thread_propose', { title: 'Seed round', goal: 'g' }, 'ap-1');
      expect(svc.mintThread).toHaveBeenCalledWith(expect.objectContaining({ scopeId: 's1' }));
    });

    it('thread_propose with a scope the agent is not granted returns a tool error and mints nothing', async () => {
      const res = await runApprovedThreadTool('a1', 'thread_propose', { title: 'Seed round', goal: 'g', scope: 'secret' }, 'ap-1');
      expect(res.success).toBe(false);
      expect(res.isToolError).toBe(true);
      expect(JSON.stringify(res.data)).toContain('SCOPE_NOT_GRANTED');
      expect(svc.mintThread).not.toHaveBeenCalled();
    });

    it('refuses malformed arguments before minting', async () => {
      for (const args of [
        { goal: 'g' },
        { title: '  ', goal: 'g' },
        { title: 'x', goal: 7 },
        { title: 'x', goal: 'g', target_date: 'not a date' },
        { title: 'x', goal: 'g', now: 3 },
        { title: 'x', goal: 'g', watchers: 'gmail_sender:bob' },
        { title: 'x', goal: 'g', watchers: [null] },
      ]) {
        const res = await runApprovedThreadTool('a1', 'thread_propose', args, 'ap-1');
        expect(res).toMatchObject({ success: false, isToolError: true });
      }
      expect(svc.mintThread).not.toHaveBeenCalled();
    });

    it('thread_propose with watchers mints, then re-runs checkWatcherAccess and adds each watcher via addWatcher', async () => {
      const res = await runApprovedThreadTool('a1', 'thread_propose', {
        title: 'Seed round', goal: 'g',
        watchers: [
          { kind: 'gmail_sender', value: 'bob@x.com', account: 'ana@y.com' },
          { kind: 'hx_project', value: 'p-1' },
        ],
      }, 'ap-1');

      expect(svc.mintThread).toHaveBeenCalledTimes(1);
      expect(watchers.checkWatcherAccess).toHaveBeenCalledWith('a1', { kind: 'gmail_sender', value: 'bob@x.com', account: 'ana@y.com' });
      expect(watchers.checkWatcherAccess).toHaveBeenCalledWith('a1', { kind: 'hx_project', value: 'p-1', account: undefined });
      expect(watchers.addWatcher).toHaveBeenCalledWith('t1', 'a1', { kind: 'gmail_sender', value: 'bob@x.com', account: 'ana@y.com' });
      expect(watchers.addWatcher).toHaveBeenCalledWith('t1', 'a1', { kind: 'hx_project', value: 'p-1', account: undefined });
      expect(svc.mintThread.mock.invocationCallOrder[0]).toBeLessThan(watchers.checkWatcherAccess.mock.invocationCallOrder[0]);
      expect(res.success).toBe(true);
    });

    it('a watcher whose access was lost by approval time is not added, and is reported', async () => {
      watchers.checkWatcherAccess
        .mockResolvedValueOnce({ ok: false, message: 'WATCHER_SOURCE_NOT_GRANTED: gone.' })
        .mockResolvedValueOnce({ ok: true });

      const res = await runApprovedThreadTool('a1', 'thread_propose', {
        title: 'Seed round', goal: 'g',
        watchers: [{ kind: 'gmail_sender', value: 'bob@x.com' }, { kind: 'hx_project', value: 'p-1' }],
      }, 'ap-1');

      expect(watchers.addWatcher).toHaveBeenCalledTimes(1);
      expect(watchers.addWatcher).toHaveBeenCalledWith('t1', 'a1', { kind: 'hx_project', value: 'p-1', account: undefined });
      expect(res.success).toBe(true);
      expect(res.data).toEqual({
        thread,
        watchers: [{ id: 'w1' }],
        refusedWatchers: [{ kind: 'gmail_sender', value: 'bob@x.com', message: 'WATCHER_SOURCE_NOT_GRANTED: gone.' }],
      });
    });

    it('a mint failure is a tool error', async () => {
      svc.mintThread.mockRejectedValue(new Error('A thread named "Seed round" already exists in this scope'));
      const res = await runApprovedThreadTool('a1', 'thread_propose', { title: 'Seed round', goal: 'g' }, 'ap-1');
      expect(res).toMatchObject({ success: false, isToolError: true });
      expect(JSON.stringify(res.data)).toContain('already exists');
    });
  });

  describe('thread_close', () => {
    const closeArgs = {
      thread_id: 't1',
      retrospective: 'It went well.',
      decisions: [
        { item_id: 'i1', action: 'cancel' },
        { item_id: 'i2', action: 'carry', successor_thread_id: 't2' },
        { item_id: 'i3', action: 'carry' },
      ],
    };

    it('thread_close loads the thread within the agent\'s scopes and calls closeThread', async () => {
      svc.getThread.mockImplementation(async (id: string) => ({ ...thread, id }));

      const res = await runApprovedThreadTool('a1', 'thread_close', closeArgs, 'ap-2');

      expect(svc.getThread).toHaveBeenCalledWith('t1', ['s1', 's2']);
      expect(svc.closeThread).toHaveBeenCalledWith(thread, {
        retrospective: 'It went well.',
        decisions: [
          { itemId: 'i1', action: 'cancel' },
          { itemId: 'i2', action: 'carry', successorThreadId: 't2' },
          { itemId: 'i3', action: 'carry' },
        ],
      });
      expect(res).toEqual({ success: true, data: { ...thread, status: 'closed' } });
    });

    it('a thread outside the agent\'s scopes is not found and nothing closes', async () => {
      svc.getThread.mockResolvedValue(null);
      const res = await runApprovedThreadTool('a1', 'thread_close', closeArgs, 'ap-2');
      expect(res).toMatchObject({ success: false, isToolError: true });
      expect(svc.closeThread).not.toHaveBeenCalled();
    });

    it('a successor outside the agent\'s scopes is refused', async () => {
      svc.getThread.mockImplementation(async (id: string) => (id === 't1' ? thread : null));
      const res = await runApprovedThreadTool('a1', 'thread_close', closeArgs, 'ap-2');
      expect(res).toMatchObject({ success: false, isToolError: true });
      expect(JSON.stringify(res.data)).toContain('SUCCESSOR_INVALID');
      expect(svc.closeThread).not.toHaveBeenCalled();
    });

    it('refuses malformed decisions before closing', async () => {
      for (const decisions of ['all', [null], [{ action: 'cancel' }], [{ item_id: 'i1', action: 'keep' }], [{ item_id: 'i1', action: 'carry', successor_thread_id: 5 }]]) {
        const res = await runApprovedThreadTool('a1', 'thread_close', { ...closeArgs, decisions }, 'ap-2');
        expect(res).toMatchObject({ success: false, isToolError: true });
      }
      const res = await runApprovedThreadTool('a1', 'thread_close', { ...closeArgs, retrospective: 3 }, 'ap-2');
      expect(res).toMatchObject({ success: false, isToolError: true });
      expect(svc.closeThread).not.toHaveBeenCalled();
    });

    it('a ThreadError from closeThread is a tool error carrying its code', async () => {
      svc.closeThread.mockRejectedValue(new ThreadError('THREAD_CLOSED', 'This thread is closed'));
      const res = await runApprovedThreadTool('a1', 'thread_close', { ...closeArgs, decisions: [] }, 'ap-2');
      expect(res).toEqual({ success: false, isToolError: true, data: { error: 'THREAD_CLOSED: This thread is closed' } });
    });
  });

  describe('thread_add_watcher', () => {
    const args = { thread_id: 't1', kind: 'gmail_query', value: 'from:vc', account: 'ana@y.com' };

    it('adds the watcher to a thread within the agent\'s scopes after re-checking access', async () => {
      const res = await runApprovedThreadTool('a1', 'thread_add_watcher', args, 'ap-3');
      expect(svc.getThread).toHaveBeenCalledWith('t1', ['s1', 's2']);
      expect(watchers.checkWatcherAccess).toHaveBeenCalledWith('a1', { kind: 'gmail_query', value: 'from:vc', account: 'ana@y.com' });
      expect(watchers.addWatcher).toHaveBeenCalledWith('t1', 'a1', { kind: 'gmail_query', value: 'from:vc', account: 'ana@y.com' });
      expect(res).toEqual({ success: true, data: { id: 'w1' } });
    });

    it('thread_add_watcher re-checks access at execution and returns a tool error if it was lost', async () => {
      watchers.checkWatcherAccess.mockResolvedValue({ ok: false, message: 'WATCHER_SOURCE_NOT_GRANTED: gone.' });
      const res = await runApprovedThreadTool('a1', 'thread_add_watcher', args, 'ap-3');
      expect(res).toEqual({ success: false, isToolError: true, data: { error: 'WATCHER_SOURCE_NOT_GRANTED: gone.' } });
      expect(watchers.addWatcher).not.toHaveBeenCalled();
    });

    it('refuses a thread outside the agent\'s scopes, and a closed thread', async () => {
      svc.getThread.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...thread, status: 'closed' });
      for (let i = 0; i < 2; i++) {
        const res = await runApprovedThreadTool('a1', 'thread_add_watcher', args, 'ap-3');
        expect(res).toMatchObject({ success: false, isToolError: true });
      }
      expect(watchers.addWatcher).not.toHaveBeenCalled();
    });
  });
});
