/**
 * Hermeneutix handler tests — pagination on list_meetings.
 *
 * The tool used to return every meeting in a project with 5 instances fanned
 * out per meeting (~6x the output, N+1 requests), which overflowed MCP client
 * output limits outright. Handlers call the global `fetch`; we stub it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerContext } from '../common/types.js';
import {
  handleListMeetings,
  handleListProjects,
  handleListSpeakers,
  handleSearchInstances,
  handleListProjectSessions,
  handleListMeetingInstances,
  handleGetMeetingInstance,
  handleListInstanceSessions,
  handleGetConversationPreview,
  handleSearchProfiles,
  pinnedProject,
  outOfScope,
} from './handlers.js';
import {
  listProjectsTool,
  listMeetingsTool,
  listSpeakersTool,
  searchInstancesTool,
  listProjectSessionsTool,
  listMeetingInstancesTool,
  getMeetingInstanceTool,
} from './tools.js';

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

const PINNED_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

const pinnedContext: ServerContext = {
  requestId: 'test-request-id',
  accessToken: 'test-token',
  instanceConfig: { projectId: PINNED_ID, projectName: 'Acme Weekly' },
};

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

describe('pinnedProject', () => {
  it('returns null when instanceConfig is absent or has no projectId', () => {
    expect(pinnedProject(context)).toBeNull();
    expect(pinnedProject({ ...context, instanceConfig: {} })).toBeNull();
    expect(pinnedProject({ ...context, instanceConfig: { projectId: '' } })).toBeNull();
    expect(pinnedProject({ ...context, instanceConfig: { projectId: 42 } })).toBeNull();
  });

  it('returns id and name when pinned', () => {
    expect(pinnedProject(pinnedContext)).toEqual({ id: PINNED_ID, name: 'Acme Weekly' });
    expect(pinnedProject({ ...context, instanceConfig: { projectId: PINNED_ID } })).toEqual({
      id: PINNED_ID,
      name: undefined,
    });
  });
});

describe('outOfScope', () => {
  it('names the project by name and id, falling back to id alone', () => {
    expect(outOfScope({ id: PINNED_ID, name: 'Acme Weekly' }, 'meeting m1 belongs to another project')).toEqual({
      success: false,
      error: `This agent is limited to Hermeneutix project "Acme Weekly" (${PINNED_ID}); meeting m1 belongs to another project`,
    });
    expect(outOfScope({ id: PINNED_ID }, 'x')).toEqual({
      success: false,
      error: `This agent is limited to Hermeneutix project "${PINNED_ID}" (${PINNED_ID}); x`,
    });
  });
});

describe('handleListProjects (pinned)', () => {
  it('returns only the pinned project', async () => {
    fetchMock.mockResolvedValueOnce(
      response([{ id: OTHER_ID, name: 'Other' }, { id: PINNED_ID, name: 'Acme Weekly' }])
    );

    const result = await handleListProjects({}, pinnedContext);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ projects: [{ id: PINNED_ID, name: 'Acme Weekly' }] });
  });

  it('errors when the pinned project is absent from the list', async () => {
    fetchMock.mockResolvedValueOnce(response([{ id: OTHER_ID, name: 'Other' }]));

    const result = await handleListProjects({}, pinnedContext);

    expect(result).toEqual({
      success: false,
      error: `Pinned project "Acme Weekly" (${PINNED_ID}) is no longer accessible to this Hermeneutix token`,
    });
  });

  it('returns every project when unpinned', async () => {
    const rows = [{ id: OTHER_ID, name: 'Other' }, { id: PINNED_ID, name: 'Acme Weekly' }];
    fetchMock.mockResolvedValueOnce(response(rows));

    const result = await handleListProjects({}, context);

    expect(result.data).toEqual({ projects: rows });
  });
});

describe('project-scoped tools (pinned)', () => {
  const cases: Array<{
    name: string;
    call: (args: Record<string, unknown>, ctx: ServerContext) => Promise<{ success: boolean; error?: string }>;
    path: string;
  }> = [
    { name: 'list_meetings', call: handleListMeetings, path: `/projects/${PINNED_ID}/meetings/` },
    { name: 'list_speakers', call: handleListSpeakers, path: `/projects/${PINNED_ID}/speakers/` },
    { name: 'search_instances', call: handleSearchInstances, path: `/v1/projects/${PINNED_ID}/instances/search/` },
    { name: 'list_sessions', call: handleListProjectSessions, path: `/v1/projects/${PINNED_ID}/sessions/` },
  ];

  for (const { name, call, path } of cases) {
    it(`${name}: fills in the pinned project when project_id is omitted`, async () => {
      fetchMock.mockResolvedValueOnce(response([]));

      const result = await call({}, pinnedContext);

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0] as string).toContain(path);
    });

    it(`${name}: rejects a different project_id without calling the API`, async () => {
      const result = await call({ project_id: OTHER_ID }, pinnedContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain(`limited to Hermeneutix project "Acme Weekly" (${PINNED_ID})`);
      expect(result.error).toContain(OTHER_ID);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it(`${name}: accepts the pinned project_id`, async () => {
      fetchMock.mockResolvedValueOnce(response([]));

      const result = await call({ project_id: PINNED_ID }, pinnedContext);

      expect(result.success).toBe(true);
      expect(fetchMock.mock.calls[0][0] as string).toContain(path);
    });

    it(`${name}: still requires project_id when unpinned`, async () => {
      const result = await call({}, context);

      expect(result).toEqual({ success: false, error: 'project_id is required' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it('list_sessions dispatcher routes to the pinned project when neither id is given', async () => {
    fetchMock.mockResolvedValueOnce(response({ sessions: [] }));

    const result = await listProjectSessionsTool.handler({}, pinnedContext);

    expect(result.success).toBe(true);
    expect(fetchMock.mock.calls[0][0] as string).toContain(`/v1/projects/${PINNED_ID}/sessions/`);
  });

  it('list_sessions dispatcher still demands an id when unpinned', async () => {
    const result = await listProjectSessionsTool.handler({}, context);

    expect(result).toEqual({ success: false, error: 'Either project_id or instance_id is required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('tool schemas', () => {
  it('no longer requires project_id on project-scoped tools', () => {
    for (const tool of [listMeetingsTool, listSpeakersTool, searchInstancesTool, listProjectSessionsTool]) {
      const schema = tool.inputSchema as { required?: string[]; properties: Record<string, { description: string }> };
      expect(schema.required ?? []).not.toContain('project_id');
      expect(schema.properties.project_id.description).toContain(
        'Omit when this agent is limited to one project; it is filled in.'
      );
    }
  });

  it('list_projects says it returns only the permitted project when limited', () => {
    expect(listProjectsTool.description).toContain('limited to one project');
  });
});

describe('response-verified tools (pinned)', () => {
  const SECRET = 'transcript-that-must-not-leak';

  describe('list_meeting_instances', () => {
    it('returns the payload when meeting.project.id matches', async () => {
      const body = { meeting: { id: 'm1', project: { id: PINNED_ID } }, instances: [{ id: 'i1' }] };
      fetchMock.mockResolvedValueOnce(response(body));

      const result = await handleListMeetingInstances({ meeting_id: 'm1' }, pinnedContext);

      expect(result).toEqual({ success: true, data: body });
    });

    it('rejects a mismatch and does not leak the payload', async () => {
      fetchMock.mockResolvedValueOnce(
        response({ meeting: { id: 'm1', project: { id: OTHER_ID } }, instances: [{ id: SECRET }] })
      );

      const result = await handleListMeetingInstances({ meeting_id: 'm1' }, pinnedContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('meeting m1 belongs to another project');
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it('rejects when the project is missing from the response', async () => {
      fetchMock.mockResolvedValueOnce(response({ instances: [{ id: SECRET }] }));

      const result = await handleListMeetingInstances({ meeting_id: 'm1' }, pinnedContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('did not report which project meeting m1 belongs to');
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });
  });

  describe('get_meeting_instance', () => {
    it('returns the instance when meeting.project.id matches', async () => {
      const body = { id: 'i1', meeting: { id: 'm1', project: { id: PINNED_ID } } };
      fetchMock.mockResolvedValueOnce(response(body));

      const result = await handleGetMeetingInstance({ instance_id: 'i1' }, pinnedContext);

      expect(result).toEqual({ success: true, data: { instance: body } });
    });

    it('rejects a mismatch before any sibling fetch and does not leak', async () => {
      fetchMock.mockResolvedValueOnce(
        response({ id: 'i1', meeting_id: 'm1', meeting: { id: 'm1', project: { id: OTHER_ID } }, sessions: [SECRET] })
      );

      const result = await handleGetMeetingInstance({ instance_id: 'i1' }, pinnedContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('instance i1 belongs to another project');
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects when the project is missing', async () => {
      fetchMock.mockResolvedValueOnce(response({ id: 'i1', meeting_id: 'm1', sessions: [SECRET] }));

      const result = await handleGetMeetingInstance({ instance_id: 'i1' }, pinnedContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('did not report which project instance i1 belongs to');
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('list_sessions by instance_id', () => {
    it('returns the payload when meeting.project.id matches', async () => {
      const body = { meeting: { id: 'm1', project: { id: PINNED_ID } }, sessions: [] };
      fetchMock.mockResolvedValueOnce(response(body));

      const result = await handleListInstanceSessions({ instance_id: 'i1' }, pinnedContext);

      expect(result).toEqual({ success: true, data: body });
    });

    it('rejects a mismatch and does not leak', async () => {
      fetchMock.mockResolvedValueOnce(
        response({ meeting: { id: 'm1', project: { id: OTHER_ID } }, sessions: [SECRET] })
      );

      const result = await handleListInstanceSessions({ instance_id: 'i1' }, pinnedContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('instance i1 belongs to another project');
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it('rejects when the project is missing', async () => {
      fetchMock.mockResolvedValueOnce(response({ sessions: [SECRET] }));

      const result = await handleListInstanceSessions({ instance_id: 'i1' }, pinnedContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('did not report which project instance i1 belongs to');
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it('is reached through the dispatcher even when pinned', async () => {
      fetchMock.mockResolvedValueOnce(response({ meeting: { project: { id: PINNED_ID } }, sessions: [] }));

      await listProjectSessionsTool.handler({ instance_id: 'i1' }, pinnedContext);

      expect(fetchMock.mock.calls[0][0] as string).toContain('/v1/instances/i1/sessions/');
    });
  });

  describe('get_conversation_preview', () => {
    it('returns the payload when the pinned project is among projects', async () => {
      const body = { projects: [{ id: OTHER_ID, name: 'Other' }, { id: PINNED_ID, name: 'Acme Weekly' }], messages: [] };
      fetchMock.mockResolvedValueOnce(response(body));

      const result = await handleGetConversationPreview({ conversation_id: 'c1' }, pinnedContext);

      expect(result).toEqual({ success: true, data: body });
    });

    it('rejects when projects excludes the pinned one', async () => {
      fetchMock.mockResolvedValueOnce(response({ projects: [{ id: OTHER_ID }], messages: [SECRET] }));

      const result = await handleGetConversationPreview({ conversation_id: 'c1' }, pinnedContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('conversation c1 belongs to another project');
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it('rejects when projects is missing', async () => {
      fetchMock.mockResolvedValueOnce(response({ messages: [SECRET] }));

      const result = await handleGetConversationPreview({ conversation_id: 'c1' }, pinnedContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('did not report which project conversation c1 belongs to');
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it('verifies the fallback preview response too', async () => {
      fetchMock
        .mockResolvedValueOnce(response({}, 500))
        .mockResolvedValueOnce(response({ projects: [{ id: OTHER_ID }], messages: [SECRET] }));

      const result = await handleGetConversationPreview({ conversation_id: 'c1' }, pinnedContext);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0] as string).toContain('/conversation/c1/preview/');
      expect(result.success).toBe(false);
      expect(result.error).toContain('conversation c1 belongs to another project');
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it('accepts a matching fallback preview response', async () => {
      const body = { projects: [{ id: PINNED_ID }], messages: [] };
      fetchMock.mockResolvedValueOnce(response({}, 500)).mockResolvedValueOnce(response(body));

      const result = await handleGetConversationPreview({ conversation_id: 'c1', max_messages: 50 }, pinnedContext);

      expect(result).toEqual({ success: true, data: body });
    });
  });

  it('unpinned: passes a payload through without any project field', async () => {
    const body = { instances: [{ id: 'i1' }] };
    fetchMock.mockResolvedValueOnce(response(body));

    const result = await handleListMeetingInstances({ meeting_id: 'm1' }, context);

    expect(result).toEqual({ success: true, data: body });
  });
});

describe('search_profiles is unaffected by pinning', () => {
  it('sends the same request and passes the payload through', async () => {
    const rows = [{ id: 'u1', name: 'Ada' }, { id: 'u2', name: 'Grace' }];
    fetchMock.mockResolvedValue(response(rows));

    const pinnedResult = await handleSearchProfiles({ query: 'a' }, pinnedContext);
    const plainResult = await handleSearchProfiles({ query: 'a' }, context);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]).toEqual(fetchMock.mock.calls[1]);
    expect(fetchMock.mock.calls[0][0] as string).toContain('/profiles/search/?q=a');
    expect(pinnedResult).toEqual({ success: true, data: { profiles: rows } });
    expect(pinnedResult).toEqual(plainResult);
  });
});

describe('malformed instanceConfig is treated as unpinned', () => {
  const malformed: Array<[string, ServerContext]> = [
    ['no projectId', { ...context, instanceConfig: { projectName: 'Acme Weekly' } }],
    ['empty projectId', { ...context, instanceConfig: { projectId: '', projectName: 'Acme Weekly' } }],
    ['numeric projectId', { ...context, instanceConfig: { projectId: 42 } }],
    ['object projectId', { ...context, instanceConfig: { projectId: { id: PINNED_ID } } }],
  ];
  const projectTools: Array<[string, (a: Record<string, unknown>, c: ServerContext) => Promise<{ success: boolean; error?: string }>]> = [
    ['list_meetings', handleListMeetings],
    ['list_speakers', handleListSpeakers],
    ['search_instances', handleSearchInstances],
    ['list_sessions', handleListProjectSessions],
  ];

  for (const [label, ctx] of malformed) {
    for (const [name, call] of projectTools) {
      it(`${label}: ${name} still requires project_id`, async () => {
        const result = await call({}, ctx);
        expect(result).toEqual({ success: false, error: 'project_id is required' });
        expect(fetchMock).not.toHaveBeenCalled();
      });
    }

    it(`${label}: list_projects does not filter`, async () => {
      const rows = [{ id: OTHER_ID, name: 'Other' }, { id: PINNED_ID, name: 'Acme Weekly' }];
      fetchMock.mockResolvedValueOnce(response(rows));

      const result = await handleListProjects({}, ctx);

      expect(result).toEqual({ success: true, data: { projects: rows } });
    });

    it(`${label}: list_sessions dispatcher still demands an id`, async () => {
      const result = await listProjectSessionsTool.handler({}, ctx);
      expect(result).toEqual({ success: false, error: 'Either project_id or instance_id is required' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
});

describe('argument-pinned tools pass responses through untouched', () => {
  it('list_speakers returns the payload verbatim for the pinned project', async () => {
    const rows = [{ id: 's1', name: 'Ada', project: { id: OTHER_ID } }];
    fetchMock.mockResolvedValueOnce(response(rows));

    const result = await handleListSpeakers({ project_id: PINNED_ID }, pinnedContext);

    expect(result).toEqual({ success: true, data: { speakers: rows } });
  });

  it('search_instances returns the payload verbatim for the pinned project', async () => {
    const body = { results: [{ id: 'i1', meeting: { project: { id: OTHER_ID } } }], count: 1 };
    fetchMock.mockResolvedValueOnce(response(body));

    const result = await handleSearchInstances({ q: 'roadmap' }, pinnedContext);

    expect(fetchMock.mock.calls[0][0] as string).toContain(`/v1/projects/${PINNED_ID}/instances/search/?q=roadmap`);
    expect(result).toEqual({ success: true, data: body });
  });
});

describe('tool.handler wiring refuses through outOfScope', () => {
  const SECRET = 'payload-that-must-not-leak';

  it('listMeetingInstancesTool.handler', async () => {
    fetchMock.mockResolvedValueOnce(
      response({ meeting: { id: 'm1', project: { id: OTHER_ID } }, instances: [{ id: SECRET }] })
    );

    const result = await listMeetingInstancesTool.handler({ meeting_id: 'm1' }, pinnedContext);

    expect(result).toEqual(outOfScope({ id: PINNED_ID, name: 'Acme Weekly' }, 'meeting m1 belongs to another project'));
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('getMeetingInstanceTool.handler', async () => {
    fetchMock.mockResolvedValueOnce(
      response({ id: 'i1', meeting_id: 'm1', meeting: { id: 'm1', project: { id: OTHER_ID } }, sessions: [SECRET] })
    );

    const result = await getMeetingInstanceTool.handler({ instance_id: 'i1' }, pinnedContext);

    expect(result).toEqual(outOfScope({ id: PINNED_ID, name: 'Acme Weekly' }, 'instance i1 belongs to another project'));
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
