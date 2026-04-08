/**
 * Hermeneutix MCP Server Tool Handlers
 *
 * Uses the Hermeneutix REST API (Token authentication).
 * Focuses on read operations: projects, meetings, instances, speakers, transcripts.
 */

import type { ServerContext, ToolResult } from '../common/types.js';

const API_BASE = 'https://studio.curl-newton.ts.net/api';

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
  return { success: true, data: { projects: data } };
}

/**
 * List all meetings in a project, with recent_instances per meeting
 */
export async function handleListMeetings(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const projectId = args.project_id as string;
  if (!projectId) return { success: false, error: 'project_id is required' };

  const response = await apiRequest(context, `/projects/${projectId}/meetings/`);
  if (!response.ok) {
    return { success: false, error: `API error: ${response.status} ${response.statusText}` };
  }
  const raw = await response.json() as Record<string, unknown>[] | { results?: Record<string, unknown>[]; meetings?: Record<string, unknown>[] } & Record<string, unknown>;
  const meetings: Record<string, unknown>[] = Array.isArray(raw)
    ? raw
    : ((raw as Record<string, unknown[]>).results ?? (raw as Record<string, unknown[]>).meetings ?? []);

  // Fetch recent instances (last 5) for each meeting in parallel
  const meetingsWithInstances = await Promise.all(
    meetings.map(async (meeting) => {
      const meetingId = meeting.id as string;
      if (!meetingId) return meeting;
      try {
        const instResp = await apiRequest(context, `/meetings/${meetingId}/instances/`, {
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

  return { success: true, data: { meetings: meetingsWithInstances } };
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

  const response = await apiRequest(context, `/meetings/${meetingId}/instances/`, params);
  if (!response.ok) {
    return { success: false, error: `API error: ${response.status} ${response.statusText}` };
  }
  const data = await response.json() as Record<string, unknown>;
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

  // Fetch sibling instance IDs for prev/next navigation if meeting_id is available
  const meetingId = data.meeting_id as string | undefined;
  if (meetingId) {
    try {
      // Fetch one before and one after by sequence number
      const [prevResp, nextResp] = await Promise.all([
        apiRequest(context, `/meetings/${meetingId}/instances/`, {
          limit: 1,
          sort_order: 'desc',
          before: instanceId,
        }),
        apiRequest(context, `/meetings/${meetingId}/instances/`, {
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
  const projectId = args.project_id as string;
  if (!projectId) return { success: false, error: 'project_id is required' };

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
      return { success: true, data: fallbackData };
    }
    return { success: false, error: `API error: ${response.status} ${response.statusText}` };
  }
  const data = await response.json() as Record<string, unknown>;
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
 * Search across all instances in a project by keyword, date range, or topic
 */
export async function handleSearchInstances(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const projectId = args.project_id as string;
  if (!projectId) return { success: false, error: 'project_id is required' };

  const params: Record<string, string | number | undefined> = {};
  if (args.q) params['q'] = args.q as string;
  if (args.date_from) params['date_from'] = args.date_from as string;
  if (args.date_to) params['date_to'] = args.date_to as string;
  if (args.limit !== undefined) params['limit'] = args.limit as number;
  if (args.offset !== undefined) params['offset'] = args.offset as number;

  const response = await apiRequest(context, `/projects/${projectId}/instances/search/`, params);
  if (!response.ok) {
    return { success: false, error: `API error: ${response.status} ${response.statusText}` };
  }
  const data = await response.json() as Record<string, unknown>;
  return { success: true, data };
}
