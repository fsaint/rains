/**
 * Hermeneutix MCP Server Tool Handlers
 *
 * Uses the Hermeneutix REST API (Token authentication).
 * Focuses on read operations: projects, meetings, instances, speakers, transcripts.
 */

import type { ServerContext, ToolResult } from '../common/types.js';

const API_BASE = 'https://hermeneutix.btv.pw/api';

/**
 * The single project this agent's Hermeneutix instance is limited to, if any.
 * Set by the backend as `instanceConfig: { projectId, projectName }`; absent
 * means the agent may reach every project the token can.
 */
export function pinnedProject(context: ServerContext): { id: string; name?: string } | null {
  const projectId = context.instanceConfig?.projectId;
  if (typeof projectId !== 'string' || projectId === '') return null;
  const projectName = context.instanceConfig?.projectName;
  return { id: projectId, name: typeof projectName === 'string' ? projectName : undefined };
}

/**
 * The refusal returned when a pinned agent reaches for something outside its project.
 */
export function outOfScope(pinned: { id: string; name?: string }, what: string): ToolResult {
  return {
    success: false,
    error: `This agent is limited to Hermeneutix project "${pinned.name ?? pinned.id}" (${pinned.id}); ${what}`,
  };
}

async function apiRequest(
  context: ServerContext,
  path: string,
  params?: Record<string, string | number | undefined>
): Promise<Response> {
  const token = context.accessToken;
  if (!token) throw new Error('No Hermeneutix API token available');

  let url = `${API_BASE}${path}`;
  if (params) {
    const query = Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    if (query) url += `?${query}`;
  }

  return fetch(url, {
    headers: {
      Authorization: `Token ${token}`,
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Resolve the project a project-scoped tool should act on. Pinned agents get
 * the pinned id filled in and are refused any other; unpinned agents must say.
 */
function resolveProjectId(
  args: Record<string, unknown>,
  context: ServerContext
): { projectId: string } | { error: ToolResult } {
  const requested = args.project_id as string | undefined;
  const pinned = pinnedProject(context);
  if (pinned) {
    if (requested && requested !== pinned.id) {
      return { error: outOfScope(pinned, `project ${requested} is outside it`) };
    }
    return { projectId: pinned.id };
  }
  if (!requested) return { error: { success: false, error: 'project_id is required' } };
  return { projectId: requested };
}

/**
 * Fail-closed check of a response's `meeting.project.id` against the pinned
 * project. `null` means the payload may be returned.
 */
function checkMeetingProject(
  context: ServerContext,
  data: Record<string, unknown>,
  what: string
): ToolResult | null {
  const pinned = pinnedProject(context);
  if (!pinned) return null;
  const meeting = data.meeting as Record<string, unknown> | undefined;
  const project = meeting?.project as Record<string, unknown> | undefined;
  const projectId = project?.id;
  if (typeof projectId !== 'string' || projectId === '') {
    return outOfScope(pinned, `the API did not report which project ${what} belongs to`);
  }
  if (projectId !== pinned.id) return outOfScope(pinned, `${what} belongs to another project`);
  return null;
}

/**
 * Fail-closed check of a conversation response's `projects: [{id}]` list.
 */
function checkConversationProjects(
  context: ServerContext,
  data: Record<string, unknown>,
  conversationId: string
): ToolResult | null {
  const pinned = pinnedProject(context);
  if (!pinned) return null;
  const projects = data.projects;
  const what = `conversation ${conversationId}`;
  if (!Array.isArray(projects) || projects.length === 0) {
    return outOfScope(pinned, `the API did not report which project ${what} belongs to`);
  }
  const member = projects.some((p) => (p as Record<string, unknown> | null)?.id === pinned.id);
  if (!member) return outOfScope(pinned, `${what} belongs to another project`);
  return null;
}

/**
 * List active projects available to the authenticated user
 */
export async function handleListProjects(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const response = await apiRequest(context, '/mobile/projects/');
  if (!response.ok) {
    return { success: false, error: `API error: ${response.status} ${response.statusText}` };
  }
  const data = await response.json() as unknown[];

  const pinned = pinnedProject(context);
  if (pinned) {
    const own = data.find((p) => (p as Record<string, unknown> | null)?.id === pinned.id);
    if (!own) {
      return {
        success: false,
        error: `Pinned project "${pinned.name ?? pinned.id}" (${pinned.id}) is no longer accessible to this Hermeneutix token`,
      };
    }
    return { success: true, data: { projects: [own] } };
  }

  return { success: true, data: { projects: data } };
}

/**
 * List all meetings in a project, with recent_instances per meeting
 */
export async function handleListMeetings(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const resolved = resolveProjectId(args, context);
  if ('error' in resolved) return resolved.error;
  const { projectId } = resolved;

  const limit = Math.min(Math.max(Math.trunc(Number(args.limit ?? 25)) || 25, 1), 100);
  const offset = Math.max(Math.trunc(Number(args.offset ?? 0)) || 0, 0);
  const includeRecent = args.include_recent_instances === true;

  const response = await apiRequest(context, `/projects/${projectId}/meetings/`, { limit, offset });
  if (!response.ok) {
    return { success: false, error: `API error: ${response.status} ${response.statusText}` };
  }
  const raw = await response.json() as Record<string, unknown>[] | { results?: Record<string, unknown>[]; meetings?: Record<string, unknown>[]; count?: unknown; next?: unknown } & Record<string, unknown>;
  const extracted = Array.isArray(raw) ? raw : (raw.results ?? raw.meetings ?? []);
  const all: Record<string, unknown>[] = Array.isArray(extracted) ? extracted : [];

  // A DRF envelope means upstream paginated; a bare array means it ignored the
  // params, so the page is cut here — either way the tool's contract holds.
  let meetings: Record<string, unknown>[];
  let total: number;
  if (Array.isArray(raw)) {
    total = all.length;
    meetings = all.slice(offset, offset + limit);
  } else {
    meetings = all;
    total = typeof raw.count === 'number' ? raw.count : offset + all.length + (raw.next ? 1 : 0);
  }

  // The instance fan-out is one request per meeting and ~6x the output, so it
  // is opt-in: discovery ("what series exist") must not pay for lookback.
  if (includeRecent) {
    meetings = await Promise.all(
      meetings.map(async (meeting) => {
        const meetingId = meeting.id as string;
        if (!meetingId) return meeting;
        try {
          const instResp = await apiRequest(context, `/v1/meetings/${meetingId}/instances/`, {
            limit: 5,
            sort_order: 'desc',
          });
          if (instResp.ok) {
            const instData = await instResp.json() as Record<string, unknown>;
            return { ...meeting, recent_instances: instData.instances ?? instData };
          }
        } catch {
          // Non-fatal: return meeting without recent_instances
        }
        return meeting;
      })
    );
  }

  return { success: true, data: { meetings, total, offset, limit, has_more: offset + meetings.length < total } };
}

/**
 * List all instances for a meeting with pagination and sort order
 */
export async function handleListMeetingInstances(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const meetingId = args.meeting_id as string;
  if (!meetingId) return { success: false, error: 'meeting_id is required' };

  const params: Record<string, string | number | undefined> = {};
  if (args.limit !== undefined) params['limit'] = args.limit as number;
  if (args.offset !== undefined) params['offset'] = args.offset as number;
  if (args.before !== undefined) params['before'] = args.before as string;
  if (args.after !== undefined) params['after'] = args.after as string;
  params['sort_order'] = (args.sort_order as string | undefined) ?? 'desc';

  const response = await apiRequest(context, `/v1/meetings/${meetingId}/instances/`, params);
  if (!response.ok) {
    return { success: false, error: `API error: ${response.status} ${response.statusText}` };
  }
  const data = await response.json() as Record<string, unknown>;
  const refused = checkMeetingProject(context, data, `meeting ${meetingId}`);
  if (refused) return refused;
  return { success: true, data };
}

/**
 * Get full meeting instance detail including sessions, transcripts, and prev/next navigation
 */
export async function handleGetMeetingInstance(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const instanceId = args.instance_id as string;
  if (!instanceId) return { success: false, error: 'instance_id is required' };

  const response = await apiRequest(context, `/v1/instances/${instanceId}/`);
  if (!response.ok) {
    return { success: false, error: `API error: ${response.status} ${response.statusText}` };
  }
  const data = await response.json() as Record<string, unknown>;
  const refused = checkMeetingProject(context, data, `instance ${instanceId}`);
  if (refused) return refused;

  // Fetch sibling instance IDs for prev/next navigation if meeting_id is available
  const meetingId = data.meeting_id as string | undefined;
  if (meetingId) {
    try {
      // Fetch one before and one after by sequence number
      const [prevResp, nextResp] = await Promise.all([
        apiRequest(context, `/v1/meetings/${meetingId}/instances/`, {
          limit: 1,
          sort_order: 'desc',
          before: instanceId,
        }),
        apiRequest(context, `/v1/meetings/${meetingId}/instances/`, {
          limit: 1,
          sort_order: 'asc',
          after: instanceId,
        }),
      ]);

      let previousInstanceId: string | null = null;
      let nextInstanceId: string | null = null;

      if (prevResp.ok) {
        const prevData = await prevResp.json() as Record<string, unknown>;
        const prevInstances = (prevData.instances ?? prevData) as Record<string, unknown>[];
        if (Array.isArray(prevInstances) && prevInstances.length > 0) {
          previousInstanceId = prevInstances[0].id as string;
        }
      }
      if (nextResp.ok) {
        const nextData = await nextResp.json() as Record<string, unknown>;
        const nextInstances = (nextData.instances ?? nextData) as Record<string, unknown>[];
        if (Array.isArray(nextInstances) && nextInstances.length > 0) {
          nextInstanceId = nextInstances[0].id as string;
        }
      }

      return {
        success: true,
        data: { instance: { ...data, previous_instance_id: previousInstanceId, next_instance_id: nextInstanceId } },
      };
    } catch {
      // Non-fatal: return instance without navigation
    }
  }

  return { success: true, data: { instance: data } };
}

/**
 * List project members available for speaker selection
 */
export async function handleListSpeakers(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const resolved = resolveProjectId(args, context);
  if ('error' in resolved) return resolved.error;
  const { projectId } = resolved;

  const response = await apiRequest(context, `/projects/${projectId}/speakers/`);
  if (!response.ok) {
    return { success: false, error: `API error: ${response.status} ${response.statusText}` };
  }
  const data = await response.json() as unknown[];
  return { success: true, data: { speakers: data } };
}

/**
 * Retrieve a conversation transcript, optionally capped at max_messages (default: unlimited)
 */
export async function handleGetConversationPreview(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const conversationId = args.conversation_id as string;
  if (!conversationId) return { success: false, error: 'conversation_id is required' };

  const maxMessages = args.max_messages as number | undefined;

  // Use the full conversation endpoint when no cap is needed (or a high cap is requested),
  // fall back to the preview endpoint for the default 10-message case.
  const useFull = maxMessages === undefined || maxMessages > 10;
  const path = useFull
    ? `/conversation/${conversationId}/`
    : `/conversation/${conversationId}/preview/`;

  const params: Record<string, string | number | undefined> = {};
  if (maxMessages !== undefined) params['max_messages'] = maxMessages;

  const response = await apiRequest(context, path, params);
  if (!response.ok) {
    // Fall back to preview endpoint if full endpoint not available
    if (useFull) {
      const fallback = await apiRequest(context, `/conversation/${conversationId}/preview/`, params);
      if (!fallback.ok) {
        return { success: false, error: `API error: ${fallback.status} ${fallback.statusText}` };
      }
      const fallbackData = await fallback.json() as Record<string, unknown>;
      const refused = checkConversationProjects(context, fallbackData, conversationId);
      if (refused) return refused;
      return { success: true, data: fallbackData };
    }
    return { success: false, error: `API error: ${response.status} ${response.statusText}` };
  }
  const data = await response.json() as Record<string, unknown>;
  const refused = checkConversationProjects(context, data, conversationId);
  if (refused) return refused;
  return { success: true, data };
}

/**
 * Search speaker profiles by name or email
 */
export async function handleSearchProfiles(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const query = args.query as string | undefined;
  const params: Record<string, string | number | undefined> = {};
  if (query) params['q'] = query;

  const response = await apiRequest(context, '/profiles/search/', params);
  if (!response.ok) {
    return { success: false, error: `API error: ${response.status} ${response.statusText}` };
  }
  const data = await response.json() as unknown[];
  return { success: true, data: { profiles: data } };
}

/**
 * List all sessions (conversations) in a project
 */
export async function handleListProjectSessions(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const resolved = resolveProjectId(args, context);
  if ('error' in resolved) return resolved.error;
  const { projectId } = resolved;

  const params: Record<string, string | number | undefined> = {};
  if (args.page !== undefined) params['page'] = args.page as number;
  if (args.page_size !== undefined) params['page_size'] = args.page_size as number;
  if (args.include !== undefined) params['include'] = args.include as string;

  const response = await apiRequest(context, `/v1/projects/${projectId}/sessions/`, params);
  if (!response.ok) {
    return { success: false, error: `API error: ${response.status} ${response.statusText}` };
  }
  const data = await response.json() as Record<string, unknown>;
  return { success: true, data };
}

/**
 * List all sessions (conversations) assigned to a meeting instance
 */
export async function handleListInstanceSessions(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const instanceId = args.instance_id as string;
  if (!instanceId) return { success: false, error: 'instance_id is required' };

  const params: Record<string, string | number | undefined> = {};
  if (args.include !== undefined) params['include'] = args.include as string;

  const response = await apiRequest(context, `/v1/instances/${instanceId}/sessions/`, params);
  if (!response.ok) {
    return { success: false, error: `API error: ${response.status} ${response.statusText}` };
  }
  const data = await response.json() as Record<string, unknown>;
  const refused = checkMeetingProject(context, data, `instance ${instanceId}`);
  if (refused) return refused;
  return { success: true, data };
}

/**
 * Search across all instances in a project by keyword, date range, or topic
 */
export async function handleSearchInstances(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const resolved = resolveProjectId(args, context);
  if ('error' in resolved) return resolved.error;
  const { projectId } = resolved;

  const params: Record<string, string | number | undefined> = {};
  if (args.q) params['q'] = args.q as string;
  if (args.date_from) params['date_from'] = args.date_from as string;
  if (args.date_to) params['date_to'] = args.date_to as string;
  if (args.limit !== undefined) params['limit'] = args.limit as number;
  if (args.offset !== undefined) params['offset'] = args.offset as number;

  const response = await apiRequest(context, `/v1/projects/${projectId}/instances/search/`, params);
  if (!response.ok) {
    return { success: false, error: `API error: ${response.status} ${response.statusText}` };
  }
  const data = await response.json() as Record<string, unknown>;
  return { success: true, data };
}
