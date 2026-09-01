/**
 * Hermeneutix handler tests — pagination on list_meetings.
 *
 * The tool used to return every meeting in a project with 5 instances fanned
 * out per meeting (~6x the output, N+1 requests), which overflowed MCP client
 * output limits outright. Handlers call the global `fetch`; we stub it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerContext } from '../common/types.js';
import { handleListMeetings } from './handlers.js';

const context: ServerContext = {
  requestId: 'test-request-id',
  accessToken: 'test-token',
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 401 ? 'Unauthorized' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const meetingRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `m${i}`, name: `Meeting ${i}` }));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handleListMeetings', () => {
  it('sends limit/offset and makes exactly one request by default (no fan-out)', async () => {
    fetchMock.mockResolvedValueOnce(response(meetingRows(3)));

    const result = await handleListMeetings({ project_id: 'p1' }, context);

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/projects/p1/meetings/');
    expect(url).toContain('limit=25');
    expect(url).toContain('offset=0');
    const data = result.data as { meetings: unknown[] };
    expect(data.meetings).toHaveLength(3);
    expect((data.meetings[0] as Record<string, unknown>).recent_instances).toBeUndefined();
  });

  it('pages a bare-array body client-side when upstream ignores the params', async () => {
    fetchMock.mockResolvedValueOnce(response(meetingRows(60)));

    const result = await handleListMeetings({ project_id: 'p1', limit: 10, offset: 50 }, context);

    const data = result.data as { meetings: unknown[]; total: number; has_more: boolean };
    expect(data.meetings).toHaveLength(10);
    expect(data.total).toBe(60);
    expect(data.has_more).toBe(false);
  });

  it('reports has_more when a page remains', async () => {
    fetchMock.mockResolvedValueOnce(response(meetingRows(60)));

    const result = await handleListMeetings({ project_id: 'p1', limit: 10, offset: 0 }, context);

    const data = result.data as { meetings: unknown[]; has_more: boolean };
    expect(data.meetings).toHaveLength(10);
    expect(data.has_more).toBe(true);
  });

  it('trusts a DRF envelope: results pass through and count is authoritative', async () => {
    fetchMock.mockResolvedValueOnce(
      response({ count: 120, next: 'https://x/?offset=25', results: meetingRows(25) })
    );

    const result = await handleListMeetings({ project_id: 'p1' }, context);

    const data = result.data as { meetings: unknown[]; total: number; has_more: boolean };
    expect(data.meetings).toHaveLength(25);
    expect(data.total).toBe(120);
    expect(data.has_more).toBe(true);
  });

  it('clamps limit to 100 and falls back to 25 on a non-positive value', async () => {
    fetchMock.mockResolvedValue(response([]));

    await handleListMeetings({ project_id: 'p1', limit: 500 }, context);
    expect(fetchMock.mock.calls[0][0] as string).toContain('limit=100');

    await handleListMeetings({ project_id: 'p1', limit: 0 }, context);
    expect(fetchMock.mock.calls[1][0] as string).toContain('limit=25');
  });

  it('fans out instances only when include_recent_instances is set', async () => {
    fetchMock
      .mockResolvedValueOnce(response(meetingRows(2)))
      .mockResolvedValueOnce(response({ instances: [{ id: 'i1' }] }))
      .mockResolvedValueOnce(response({}, 500));

    const result = await handleListMeetings(
      { project_id: 'p1', include_recent_instances: true },
      context
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0] as string).toContain('/v1/meetings/m0/instances/');
    expect(fetchMock.mock.calls[1][0] as string).toContain('limit=5');
    const meetings = (result.data as { meetings: Record<string, unknown>[] }).meetings;
    expect(meetings[0].recent_instances).toEqual([{ id: 'i1' }]);
    // A failing instance fetch is non-fatal: that meeting simply has no key.
    expect(meetings[1].recent_instances).toBeUndefined();
  });

  it('surfaces a 401 as the pinned API-error string', async () => {
    // The reauth hook in agent-endpoint matches this exact shape.
    fetchMock.mockResolvedValueOnce(response({}, 401));

    const result = await handleListMeetings({ project_id: 'p1' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toBe('API error: 401 Unauthorized');
  });

  it('requires project_id', async () => {
    const result = await handleListMeetings({}, context);
    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
