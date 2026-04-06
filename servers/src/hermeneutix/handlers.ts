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
 * List all meetings in a project
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
  const data = await response.json() as unknown[];
  return { success: true, data: { meetings: data } };
}

/**
 * Get full meeting instance detail including sessions and transcripts
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
  return { success: true, data };
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
 * Retrieve a conversation preview (first 10 messages)
 */
export async function handleGetConversationPreview(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const conversationId = args.conversation_id as string;
  if (!conversationId) return { success: false, error: 'conversation_id is required' };

  const response = await apiRequest(context, `/conversation/${conversationId}/preview/`);
  if (!response.ok) {
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
