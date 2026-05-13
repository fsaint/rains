/**
 * Memory MCP Handler Tests
 *
 * Tests each handler by mocking global.fetch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleGetRoot,
  handleCreate,
  handleUpdate,
  handleSearch,
  handleList,
  handleGet,
  handleRelate,
  handleDelete,
  handleDream,
  handleSetParent,
} from './handlers.js';
import type { ServerContext } from '../common/types.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Set a predictable API base URL
process.env.REINS_API_URL = 'https://test.agenthelm.mom';

const mockContext = {
  requestId: 'test-request-id',
  gatewayToken: 'test-gateway-token',
} as unknown as ServerContext;

function makeOkResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
    text: async () => JSON.stringify({ data }),
  };
}

function makeErrorResponse(status: number, body = 'Error') {
  return {
    ok: false,
    status,
    json: async () => ({ error: body }),
    text: async () => body,
  };
}

describe('Memory Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // handleGetRoot
  // ==========================================================================

  describe('handleGetRoot', () => {
    it('calls GET /api/memory/root with gateway token header', async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({ id: 'root-1', title: 'Memory Index', content: '# Memory Index' }));

      await handleGetRoot({}, mockContext);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.agenthelm.mom/api/memory/root');
      expect(opts?.headers?.['x-reins-agent-secret']).toBe('test-gateway-token');
    });

    it('returns entry id, title, content on success', async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({ id: 'root-1', title: 'Memory Index', content: '# hi' }));

      const result = await handleGetRoot({}, mockContext);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ id: 'root-1', title: 'Memory Index', content: '# hi' });
    });

    it('returns error on non-200 response', async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(500));

      const result = await handleGetRoot({}, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  // ==========================================================================
  // handleCreate
  // ==========================================================================

  describe('handleCreate', () => {
    it('calls POST /api/memory/entries with title, type, content, parent_id, attributes', async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({ id: 'new-entry' }));

      await handleCreate(
        { title: 'My Note', type: 'note', content: 'content', parent_id: 'root-1', attributes: [] },
        mockContext
      );

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.agenthelm.mom/api/memory/entries');
      expect(opts?.method).toBe('POST');
      const body = JSON.parse(opts?.body as string);
      expect(body).toMatchObject({ title: 'My Note', type: 'note', content: 'content', parent_id: 'root-1' });
    });

    it('defaults type to note when not provided', async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({ id: 'new-entry' }));

      await handleCreate({ title: 'My Note' }, mockContext);

      const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
      expect(body.type).toBe('note');
    });

    it('returns created entry data on success', async () => {
      const entry = { id: 'new-entry', title: 'My Note', type: 'note' };
      mockFetch.mockResolvedValueOnce(makeOkResponse(entry));

      const result = await handleCreate({ title: 'My Note' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(entry);
    });

    it('returns error on failure', async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(400, 'title is required'));

      const result = await handleCreate({}, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  // ==========================================================================
  // handleUpdate
  // ==========================================================================

  describe('handleUpdate', () => {
    it('calls PUT /api/memory/entries/:id with fields', async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({ id: 'entry-1', title: 'Updated' }));

      await handleUpdate({ id: 'entry-1', title: 'Updated', content: 'new content' }, mockContext);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.agenthelm.mom/api/memory/entries/entry-1');
      expect(opts?.method).toBe('PUT');
      const body = JSON.parse(opts?.body as string);
      expect(body.title).toBe('Updated');
      expect(body.content).toBe('new content');
    });

    it('does not include id in the PUT body', async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({ id: 'entry-1' }));

      await handleUpdate({ id: 'entry-1', title: 'New Title' }, mockContext);

      const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
      expect(body.id).toBeUndefined();
    });

    it('returns error on 404', async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(404, 'Not found'));

      const result = await handleUpdate({ id: 'missing', title: 'x' }, mockContext);

      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // handleSearch
  // ==========================================================================

  describe('handleSearch', () => {
    it('calls GET /api/memory/entries with q parameter', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });

      await handleSearch({ query: 'hello' }, mockContext);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/memory/entries');
      expect(url).toContain('q=hello');
    });

    it('caps limit at 50', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });

      await handleSearch({ query: 'test', limit: 100 }, mockContext);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('limit=50');
    });

    it('passes type filter when provided', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });

      await handleSearch({ query: 'test', type: 'person' }, mockContext);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('type=person');
    });

    it('returns entries array and count', async () => {
      const entries = [{ id: 'e1' }, { id: 'e2' }];
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: entries }) });

      const result = await handleSearch({ query: 'test' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.entries).toEqual(entries);
      expect(result.data.count).toBe(2);
    });
  });

  // ==========================================================================
  // handleList
  // ==========================================================================

  describe('handleList', () => {
    it('calls GET /api/memory/entries with type and parent_id params', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });

      await handleList({ type: 'note', parent_id: 'root-1' }, mockContext);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('type=note');
      expect(url).toContain('parent_id=root-1');
    });

    it('omits empty params from query string', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });

      await handleList({}, mockContext);

      const [url] = mockFetch.mock.calls[0];
      expect(url).not.toContain('type=');
      expect(url).not.toContain('parent_id=');
    });

    it('returns entries and count', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'e1' }] }) });

      const result = await handleList({}, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.count).toBe(1);
    });
  });

  // ==========================================================================
  // handleGet
  // ==========================================================================

  describe('handleGet', () => {
    it('calls GET /api/memory/entries/:id when id provided', async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({ id: 'e1', title: 'My Note' }));

      await handleGet({ id: 'e1' }, mockContext);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.agenthelm.mom/api/memory/entries/e1');
    });

    it('searches by title when only title provided', async () => {
      // First call: search by title
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'e1', title: 'Alice' }] }),
      });
      // Second call: get by id
      mockFetch.mockResolvedValueOnce(makeOkResponse({ id: 'e1', title: 'Alice' }));

      const result = await handleGet({ title: 'Alice' }, mockContext);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
    });

    it('returns error when title not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      });

      const result = await handleGet({ title: 'Nonexistent' }, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Nonexistent');
    });

    it('returns error when neither id nor title provided', async () => {
      const result = await handleGet({}, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('required');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // handleRelate
  // ==========================================================================

  describe('handleRelate', () => {
    it('calls POST /api/memory/entries/:source_id/attributes with type=relation', async () => {
      const attr = { id: 'attr-1', type: 'relation', name: 'knows', value: 'target-1' };
      mockFetch.mockResolvedValueOnce(makeOkResponse(attr));

      await handleRelate({ source_id: 'e1', relation: 'knows', target_id: 'e2' }, mockContext);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.agenthelm.mom/api/memory/entries/e1/attributes');
      expect(opts?.method).toBe('POST');
      const body = JSON.parse(opts?.body as string);
      expect(body.type).toBe('relation');
      expect(body.name).toBe('knows');
      expect(body.value).toBe('e2');
    });

    it('returns created attribute on success', async () => {
      const attr = { id: 'attr-1', type: 'relation' };
      mockFetch.mockResolvedValueOnce(makeOkResponse(attr));

      const result = await handleRelate({ source_id: 'e1', relation: 'knows', target_id: 'e2' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(attr);
    });
  });

  // ==========================================================================
  // handleDelete
  // ==========================================================================

  describe('handleDelete', () => {
    it('calls DELETE /api/memory/entries/:id', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });

      await handleDelete({ id: 'e1' }, mockContext);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.agenthelm.mom/api/memory/entries/e1');
      expect(opts?.method).toBe('DELETE');
    });

    it('returns { deleted: true, id } on success', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });

      const result = await handleDelete({ id: 'e1' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ deleted: true, id: 'e1' });
    });

    it('returns error on failure', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      const result = await handleDelete({ id: 'missing' }, mockContext);

      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // handleDream
  // ==========================================================================

  describe('handleDream', () => {
    it('calls GET /api/memory/dream with gateway token', async () => {
      const entries = [{ id: 'e1', title: 'Alice', type: 'person', parent_id: null, backlink_count: 2, updated_at: '2026-05-01Z' }];
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: entries }) });

      await handleDream({}, mockContext);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.agenthelm.mom/api/memory/dream');
      expect(opts?.headers?.['x-reins-agent-secret']).toBe('test-gateway-token');
    });

    it('returns entries array with count', async () => {
      const entries = [
        { id: 'e1', title: 'Alice', type: 'person', parent_id: 'root', backlink_count: 3, updated_at: '2026Z' },
        { id: 'e2', title: 'Acme', type: 'company', parent_id: null, backlink_count: 0, updated_at: '2026Z' },
      ];
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: entries }) });

      const result = await handleDream({}, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.entries).toEqual(entries);
      expect(result.data.count).toBe(2);
    });

    it('returns error on non-200 response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Internal error' });

      const result = await handleDream({}, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  // ==========================================================================
  // handleSetParent
  // ==========================================================================

  describe('handleSetParent', () => {
    it('calls PUT /api/memory/entries/:entry_id/parent', async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({ ok: true }));

      await handleSetParent({ entry_id: 'e1', parent_id: 'root-1' }, mockContext);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test.agenthelm.mom/api/memory/entries/e1/parent');
      expect(opts?.method).toBe('PUT');
      const body = JSON.parse(opts?.body as string);
      expect(body.parent_id).toBe('root-1');
    });

    it('sends null parent_id to move entry to top level', async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({ ok: true }));

      await handleSetParent({ entry_id: 'e1', parent_id: null }, mockContext);

      const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
      expect(body.parent_id).toBeNull();
    });

    it('returns { ok: true } on success', async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({ ok: true }));

      const result = await handleSetParent({ entry_id: 'e1', parent_id: 'root' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ ok: true });
    });

    it('returns error when entry not found', async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(404, 'Entry not found'));

      const result = await handleSetParent({ entry_id: 'missing', parent_id: 'root' }, mockContext);

      expect(result.success).toBe(false);
    });

    it('returns error on circular reference', async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(400, 'Circular reference'));

      const result = await handleSetParent({ entry_id: 'e1', parent_id: 'child-of-e1' }, mockContext);

      expect(result.success).toBe(false);
    });
  });
});
