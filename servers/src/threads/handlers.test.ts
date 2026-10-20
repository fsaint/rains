/**
 * Threads MCP Handler Tests
 *
 * Tests each handler by mocking global.fetch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { data } from '../common/test-helpers.js';
import {
  handleList,
  handleGetBrief,
  handleListCandidates,
  handleLogEvent,
  handleAddItem,
  handleUpdateItem,
  handleUpdateNow,
  handleAttachSource,
  handleAcceptCandidate,
  handleDismissCandidate,
  handlePause,
  handleResume,
  handlePropose,
  handleClose,
  handleAddWatcher,
} from './handlers.js';
import type { ServerContext } from '../common/types.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

process.env.REINS_API_URL = 'https://test.helm.mom';

const mockContext = {
  requestId: 'test-request-id',
  gatewayToken: 'test-gateway-token',
} as unknown as ServerContext;

function ok(payload: unknown, status = 200) {
  return { ok: true, status, json: async () => ({ data: payload }) };
}

function fail(status: number, body: unknown) {
  return { ok: false, status, json: async () => body };
}

const REFUSAL_SUFFIX = 'runs only through an approved request.';

function lastCall() {
  const [url, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
  return {
    url: url as string,
    init: init as RequestInit & { headers: Record<string, string> },
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  };
}

describe('threads handlers', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('thread_list', () => {
    it('GETs /api/threads with status and scope as query params', async () => {
      mockFetch.mockResolvedValueOnce(ok([{ id: 't1', title: 'Launch', status: 'active' }]));
      const result = await handleList({ status: 'active', scope: 'work' }, mockContext);
      const call = lastCall();
      expect(call.url).toBe('https://test.helm.mom/api/threads?status=active&scope=work');
      expect(call.init.headers['x-reins-agent-secret']).toBe('test-gateway-token');
      expect(result.success).toBe(true);
    });

    it('sends no scope param when none is given', async () => {
      mockFetch.mockResolvedValueOnce(ok([]));
      await handleList({}, mockContext);
      expect(lastCall().url).toBe('https://test.helm.mom/api/threads');
    });

    it('surfaces the server error message', async () => {
      mockFetch.mockResolvedValueOnce(fail(403, { error: 'The threads service is not enabled for this agent.' }));
      const result = await handleList({}, mockContext);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not enabled');
    });
  });

  describe('thread_get_brief', () => {
    it('renders the Now section and a Due now list', async () => {
      mockFetch.mockResolvedValueOnce(ok({
        thread: { id: 't1', title: 'Launch', status: 'active' },
        sections: { Goal: 'Ship it', Past: '', Now: 'Writing the announcement', Next: 'Send to press' },
        events: [{ id: 'e1', title: 'Kickoff call', occurredAt: '2026-10-01T10:00:00.000Z' }],
        openTodos: [{ id: 'i1', title: 'Draft copy', dueAt: null }],
        upcoming: [{ id: 'i2', title: 'Press embargo', dueAt: '2026-11-01T00:00:00.000Z' }],
        firedUnacknowledged: [{ id: 'i3', title: 'Call the printer', remindAt: '2026-10-18T09:00:00.000Z' }],
        pendingCandidates: [{ id: 'c1', summary: 'Re: pricing', sourceType: 'gmail', sourceRef: 'm1' }],
        activeCount: 3,
      }));
      const result = await handleGetBrief({ thread_id: 't1' }, mockContext);
      expect(lastCall().url).toBe('https://test.helm.mom/api/threads/t1/brief');
      expect(result.success).toBe(true);
      const text = String(data(result).brief);
      expect(text).toContain('Launch');
      expect(text).toContain('Now');
      expect(text).toContain('Writing the announcement');
      expect(text).toContain('Due now');
      expect(text.indexOf('Due now')).toBeGreaterThan(text.indexOf('Writing the announcement'));
      expect(text).toContain('Call the printer');
      expect(text).toContain('Upcoming');
      expect(text).toContain('Press embargo');
      expect(text).toContain('Open todos');
      expect(text).toContain('Draft copy');
      expect(text).toContain('Recent events');
      expect(text).toContain('Kickoff call');
      expect(text).toContain('New candidates');
      expect(text).toContain('Re: pricing');
    });

    it('omits empty groups', async () => {
      mockFetch.mockResolvedValueOnce(ok({
        thread: { id: 't1', title: 'Launch', status: 'active' },
        sections: { Goal: 'Ship it', Past: '', Now: 'Now text', Next: '' },
        events: [], openTodos: [], upcoming: [], firedUnacknowledged: [], pendingCandidates: [],
        activeCount: 1,
      }));
      const text = String(data(await handleGetBrief({ thread_id: 't1' }, mockContext)).brief);
      expect(text).not.toContain('Due now');
      expect(text).not.toContain('New candidates');
    });

    it('requires thread_id', async () => {
      const result = await handleGetBrief({}, mockContext);
      expect(result.success).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('thread_list_candidates', () => {
    it('GETs the candidates route', async () => {
      mockFetch.mockResolvedValueOnce(ok([{ id: 'c1' }]));
      const result = await handleListCandidates({ thread_id: 't1' }, mockContext);
      expect(lastCall().url).toBe('https://test.helm.mom/api/threads/t1/candidates');
      expect(result.success).toBe(true);
    });
  });

  describe('thread_log_event', () => {
    it('POSTs an event item with camelCased fields', async () => {
      mockFetch.mockResolvedValueOnce(ok({ id: 'i1' }, 201));
      await handleLogEvent({
        thread_id: 't1', title: 'Met the vendor', body: 'Agreed on price',
        occurred_at: '2026-10-18T12:00:00Z', source_type: 'gmail', source_ref: 'msg-1',
      }, mockContext);
      const call = lastCall();
      expect(call.url).toBe('https://test.helm.mom/api/threads/t1/items');
      expect(call.init.method).toBe('POST');
      expect(call.body).toEqual({
        kind: 'event', title: 'Met the vendor', body: 'Agreed on price',
        occurredAt: '2026-10-18T12:00:00Z', sourceType: 'gmail', sourceRef: 'msg-1',
      });
    });
  });

  describe('thread_add_item', () => {
    it('POSTs camelCased fields to /api/threads/:id/items with x-reins-agent-secret', async () => {
      mockFetch.mockResolvedValueOnce(ok({ id: 'i1' }, 201));
      const result = await handleAddItem({
        thread_id: 't1', kind: 'deadline', title: 'File taxes', body: 'Form 1040',
        due_at: '2026-04-15T00:00:00Z', remind_at: '2026-04-10T00:00:00Z',
      }, mockContext);
      const call = lastCall();
      expect(call.url).toBe('https://test.helm.mom/api/threads/t1/items');
      expect(call.init.method).toBe('POST');
      expect(call.init.headers['x-reins-agent-secret']).toBe('test-gateway-token');
      expect(call.body).toEqual({
        kind: 'deadline', title: 'File taxes', body: 'Form 1040',
        dueAt: '2026-04-15T00:00:00Z', remindAt: '2026-04-10T00:00:00Z',
      });
      expect(result.success).toBe(true);
    });

    it('rejects kind event (use thread_log_event)', async () => {
      const result = await handleAddItem({ thread_id: 't1', kind: 'event', title: 'x' }, mockContext);
      expect(result.success).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns the route error on a closed thread', async () => {
      mockFetch.mockResolvedValueOnce(fail(409, { error: 'Thread is closed', code: 'THREAD_CLOSED' }));
      const result = await handleAddItem({ thread_id: 't1', kind: 'todo', title: 'x' }, mockContext);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Thread is closed');
    });
  });

  describe('thread_update_item', () => {
    it('PATCHes the item with camelCased fields', async () => {
      mockFetch.mockResolvedValueOnce(ok({ id: 'i1' }));
      await handleUpdateItem({ thread_id: 't1', item_id: 'i1', status: 'done', due_at: '2026-10-30T00:00:00Z' }, mockContext);
      const call = lastCall();
      expect(call.url).toBe('https://test.helm.mom/api/threads/t1/items/i1');
      expect(call.init.method).toBe('PATCH');
      expect(call.body).toEqual({ status: 'done', dueAt: '2026-10-30T00:00:00Z' });
    });
  });

  describe('thread_update_item with nothing to change', () => {
    it('refuses locally', async () => {
      const result = await handleUpdateItem({ thread_id: 't1', item_id: 'i1' }, mockContext);
      expect(result.success).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('thread_update_now', () => {
    it('replaces Now and Next and appends to Past', async () => {
      mockFetch.mockResolvedValueOnce(ok({ updated: ['Now', 'Next', 'Past'] }));
      await handleUpdateNow({ thread_id: 't1', now: 'N', next: 'X', past_append: 'P' }, mockContext);
      const call = lastCall();
      expect(call.url).toBe('https://test.helm.mom/api/threads/t1/sections');
      expect(call.init.method).toBe('PUT');
      expect(call.body).toEqual({
        Now: { text: 'N', mode: 'replace' },
        Next: { text: 'X', mode: 'replace' },
        Past: { text: 'P', mode: 'append' },
      });
    });

    it('refuses when nothing is given', async () => {
      const result = await handleUpdateNow({ thread_id: 't1' }, mockContext);
      expect(result.success).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('thread_attach_source', () => {
    it('POSTs an event item carrying the source', async () => {
      mockFetch.mockResolvedValueOnce(ok({ id: 'i1' }, 201));
      await handleAttachSource({
        thread_id: 't1', source_type: 'memory', source_ref: 'entry-9', title: 'Vendor notes', memory_entry_id: 'entry-9',
      }, mockContext);
      expect(lastCall().body).toEqual({
        kind: 'event', title: 'Vendor notes', sourceType: 'memory', sourceRef: 'entry-9', memoryEntryId: 'entry-9',
      });
    });
  });

  describe('candidates', () => {
    it('accepts', async () => {
      mockFetch.mockResolvedValueOnce(ok({ id: 'i1' }));
      await handleAcceptCandidate({ thread_id: 't1', candidate_id: 'c1' }, mockContext);
      const call = lastCall();
      expect(call.url).toBe('https://test.helm.mom/api/threads/t1/candidates/c1/accept');
      expect(call.init.method).toBe('POST');
    });

    it('dismisses', async () => {
      mockFetch.mockResolvedValueOnce(ok({ dismissed: true }));
      await handleDismissCandidate({ thread_id: 't1', candidate_id: 'c1' }, mockContext);
      expect(lastCall().url).toBe('https://test.helm.mom/api/threads/t1/candidates/c1/dismiss');
    });
  });

  describe('pause and resume', () => {
    it('pause POSTs status paused', async () => {
      mockFetch.mockResolvedValueOnce(ok({ id: 't1', status: 'paused' }));
      await handlePause({ thread_id: 't1' }, mockContext);
      const call = lastCall();
      expect(call.url).toBe('https://test.helm.mom/api/threads/t1/status');
      expect(call.body).toEqual({ status: 'paused' });
    });

    it('resume POSTs status active', async () => {
      mockFetch.mockResolvedValueOnce(ok({ id: 't1', status: 'active' }));
      await handleResume({ thread_id: 't1' }, mockContext);
      expect(lastCall().body).toEqual({ status: 'active' });
    });
  });

  describe('approval-only tools', () => {
    it('thread_propose handler refuses (never reached unapproved)', async () => {
      const result = await handlePropose({ title: 'x', goal: 'y' }, mockContext);
      expect(result.success).toBe(false);
      expect(result.error).toBe(`thread_propose ${REFUSAL_SUFFIX}`);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('thread_close handler refuses', async () => {
      const result = await handleClose({ thread_id: 't1', retrospective: 'r', decisions: [] }, mockContext);
      expect(result.success).toBe(false);
      expect(result.error).toBe(`thread_close ${REFUSAL_SUFFIX}`);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('thread_add_watcher handler refuses', async () => {
      const result = await handleAddWatcher({ thread_id: 't1', kind: 'gmail_label', value: 'x' }, mockContext);
      expect(result.success).toBe(false);
      expect(result.error).toBe(`thread_add_watcher ${REFUSAL_SUFFIX}`);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
