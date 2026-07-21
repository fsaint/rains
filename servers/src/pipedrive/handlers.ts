/**
 * Pipedrive MCP Server Tool Handlers
 *
 * Uses the Pipedrive REST API v1/v2 with x-api-token header auth.
 * Base URL: https://{companydomain}.pipedrive.com/api/v1
 */

import type { ServerContext, ToolResult } from '../common/types.js';

export interface PipedriveContext extends ServerContext {
  /** Pipedrive company domain, e.g. "mycompany" from mycompany.pipedrive.com */
  companydomain: string;
}

function ctx(context: ServerContext): PipedriveContext {
  return context as PipedriveContext;
}

function buildUrl(
  domain: string,
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): string {
  let url = `https://${domain}.pipedrive.com${path}`;
  if (params) {
    const query = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    if (query) url += `?${query}`;
  }
  return url;
}

async function apiGet(
  context: PipedriveContext,
  path: string,
  params?: Record<string, string | number | boolean | undefined>
): Promise<Response> {
  const url = buildUrl(context.companydomain, path, params);
  return fetch(url, {
    headers: {
      'x-api-token': context.accessToken ?? '',
      'Content-Type': 'application/json',
    },
  });
}

async function apiPost(
  context: PipedriveContext,
  path: string,
  body: unknown
): Promise<Response> {
  const url = buildUrl(context.companydomain, path);
  return fetch(url, {
    method: 'POST',
    headers: {
      'x-api-token': context.accessToken ?? '',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function apiPatch(
  context: PipedriveContext,
  path: string,
  body: unknown
): Promise<Response> {
  const url = buildUrl(context.companydomain, path);
  return fetch(url, {
    method: 'PATCH',
    headers: {
      'x-api-token': context.accessToken ?? '',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function apiPut(
  context: PipedriveContext,
  path: string,
  body: unknown
): Promise<Response> {
  const url = buildUrl(context.companydomain, path);
  return fetch(url, {
    method: 'PUT',
    headers: {
      'x-api-token': context.accessToken ?? '',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function apiDelete(
  context: PipedriveContext,
  path: string
): Promise<Response> {
  const url = buildUrl(context.companydomain, path);
  return fetch(url, {
    method: 'DELETE',
    headers: {
      'x-api-token': context.accessToken ?? '',
      'Content-Type': 'application/json',
    },
  });
}

async function handleResponse(response: Response): Promise<ToolResult> {
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return { success: false, error: `Pipedrive API error ${response.status}: ${text || response.statusText}` };
  }
  const data = await response.json() as Record<string, unknown>;
  return { success: true, data };
}

// ─── Deals ───────────────────────────────────────────────────────────────────

export async function handleListDeals(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const params: Record<string, string | number | boolean | undefined> = {};
  if (args.owner_id) params['owner_id'] = args.owner_id as number;
  if (args.person_id) params['person_id'] = args.person_id as number;
  if (args.org_id) params['org_id'] = args.org_id as number;
  if (args.pipeline_id) params['pipeline_id'] = args.pipeline_id as number;
  if (args.stage_id) params['stage_id'] = args.stage_id as number;
  if (args.status) params['status'] = args.status as string;
  if (args.limit) params['limit'] = args.limit as number;
  if (args.cursor) params['cursor'] = args.cursor as string;
  if (args.sort_by) params['sort_by'] = args.sort_by as string;
  if (args.sort_direction) params['sort_direction'] = args.sort_direction as string;
  if (args.updated_since) params['updated_since'] = args.updated_since as string;
  return handleResponse(await apiGet(c, '/api/v1/deals', params));
}

export async function handleGetDeal(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.deal_id as number;
  if (!id) return { success: false, error: 'deal_id is required' };
  return handleResponse(await apiGet(c, `/api/v1/deals/${id}`));
}

export async function handleSearchDeals(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const term = args.term as string;
  if (!term) return { success: false, error: 'term is required' };
  const params: Record<string, string | number | boolean | undefined> = { term };
  if (args.person_id) params['person_id'] = args.person_id as number;
  if (args.org_id) params['org_id'] = args.org_id as number;
  if (args.status) params['status'] = args.status as string;
  if (args.exact_match) params['exact_match'] = args.exact_match as boolean;
  if (args.limit) params['limit'] = args.limit as number;
  if (args.cursor) params['cursor'] = args.cursor as string;
  return handleResponse(await apiGet(c, '/api/v2/deals/search', params));
}

export async function handleCreateDeal(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  if (!args.title) return { success: false, error: 'title is required' };
  const body: Record<string, unknown> = { title: args.title };
  if (args.value !== undefined) body['value'] = args.value;
  if (args.currency) body['currency'] = args.currency;
  if (args.person_id) body['person_id'] = args.person_id;
  if (args.org_id) body['org_id'] = args.org_id;
  if (args.pipeline_id) body['pipeline_id'] = args.pipeline_id;
  if (args.stage_id) body['stage_id'] = args.stage_id;
  if (args.status) body['status'] = args.status;
  if (args.expected_close_date) body['expected_close_date'] = args.expected_close_date;
  if (args.owner_id) body['user_id'] = args.owner_id;
  if (args.label) body['label'] = args.label;
  if (args.custom_fields && typeof args.custom_fields === 'object') {
    Object.assign(body, args.custom_fields as Record<string, unknown>);
  }
  return handleResponse(await apiPost(c, '/api/v1/deals', body));
}

export async function handleUpdateDeal(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.deal_id as number;
  if (!id) return { success: false, error: 'deal_id is required' };
  const body: Record<string, unknown> = {};
  if (args.title) body['title'] = args.title;
  if (args.value !== undefined) body['value'] = args.value;
  if (args.currency) body['currency'] = args.currency;
  if (args.person_id) body['person_id'] = args.person_id;
  if (args.org_id) body['org_id'] = args.org_id;
  if (args.pipeline_id) body['pipeline_id'] = args.pipeline_id;
  if (args.stage_id) body['stage_id'] = args.stage_id;
  if (args.status) body['status'] = args.status;
  if (args.expected_close_date) body['expected_close_date'] = args.expected_close_date;
  if (args.owner_id) body['user_id'] = args.owner_id;
  if (args.label) body['label'] = args.label;
  if (args.lost_reason) body['lost_reason'] = args.lost_reason;
  if (args.custom_fields && typeof args.custom_fields === 'object') {
    Object.assign(body, args.custom_fields as Record<string, unknown>);
  }
  return handleResponse(await apiPut(c, `/api/v1/deals/${id}`, body));
}

export async function handleDeleteDeal(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.deal_id as number;
  if (!id) return { success: false, error: 'deal_id is required' };
  return handleResponse(await apiDelete(c, `/api/v1/deals/${id}`));
}

// ─── Persons ─────────────────────────────────────────────────────────────────

export async function handleListPersons(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const params: Record<string, string | number | boolean | undefined> = {};
  if (args.owner_id) params['owner_id'] = args.owner_id as number;
  if (args.org_id) params['org_id'] = args.org_id as number;
  if (args.limit) params['limit'] = args.limit as number;
  if (args.cursor) params['cursor'] = args.cursor as string;
  if (args.sort_by) params['sort_by'] = args.sort_by as string;
  if (args.sort_direction) params['sort_direction'] = args.sort_direction as string;
  if (args.updated_since) params['updated_since'] = args.updated_since as string;
  return handleResponse(await apiGet(c, '/api/v1/persons', params));
}

export async function handleGetPerson(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.person_id as number;
  if (!id) return { success: false, error: 'person_id is required' };
  return handleResponse(await apiGet(c, `/api/v1/persons/${id}`));
}

export async function handleSearchPersons(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const term = args.term as string;
  if (!term) return { success: false, error: 'term is required' };
  const params: Record<string, string | number | boolean | undefined> = { term };
  if (args.fields) params['fields'] = args.fields as string;
  if (args.exact_match) params['exact_match'] = args.exact_match as boolean;
  if (args.org_id) params['org_id'] = args.org_id as number;
  if (args.limit) params['limit'] = args.limit as number;
  if (args.cursor) params['cursor'] = args.cursor as string;
  return handleResponse(await apiGet(c, '/api/v2/persons/search', params));
}

export async function handleCreatePerson(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  if (!args.name) return { success: false, error: 'name is required' };
  const body: Record<string, unknown> = { name: args.name };
  if (args.email) body['email'] = Array.isArray(args.email) ? args.email : [{ value: args.email, primary: true }];
  if (args.phone) body['phone'] = Array.isArray(args.phone) ? args.phone : [{ value: args.phone, primary: true }];
  if (args.org_id) body['org_id'] = args.org_id;
  if (args.owner_id) body['owner_id'] = args.owner_id;
  if (args.visible_to) body['visible_to'] = args.visible_to;
  return handleResponse(await apiPost(c, '/api/v1/persons', body));
}

export async function handleUpdatePerson(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.person_id as number;
  if (!id) return { success: false, error: 'person_id is required' };
  const body: Record<string, unknown> = {};
  if (args.name) body['name'] = args.name;
  if (args.email) body['email'] = Array.isArray(args.email) ? args.email : [{ value: args.email, primary: true }];
  if (args.phone) body['phone'] = Array.isArray(args.phone) ? args.phone : [{ value: args.phone, primary: true }];
  if (args.org_id) body['org_id'] = args.org_id;
  if (args.owner_id) body['owner_id'] = args.owner_id;
  if (args.visible_to) body['visible_to'] = args.visible_to;
  return handleResponse(await apiPut(c, `/api/v1/persons/${id}`, body));
}

export async function handleDeletePerson(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.person_id as number;
  if (!id) return { success: false, error: 'person_id is required' };
  return handleResponse(await apiDelete(c, `/api/v1/persons/${id}`));
}

// ─── Organizations ────────────────────────────────────────────────────────────

export async function handleListOrganizations(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const params: Record<string, string | number | boolean | undefined> = {};
  if (args.owner_id) params['owner_id'] = args.owner_id as number;
  if (args.limit) params['limit'] = args.limit as number;
  if (args.cursor) params['cursor'] = args.cursor as string;
  if (args.sort_by) params['sort_by'] = args.sort_by as string;
  if (args.sort_direction) params['sort_direction'] = args.sort_direction as string;
  if (args.updated_since) params['updated_since'] = args.updated_since as string;
  return handleResponse(await apiGet(c, '/api/v1/organizations', params));
}

export async function handleGetOrganization(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.org_id as number;
  if (!id) return { success: false, error: 'org_id is required' };
  return handleResponse(await apiGet(c, `/api/v1/organizations/${id}`));
}

export async function handleSearchOrganizations(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const term = args.term as string;
  if (!term) return { success: false, error: 'term is required' };
  const params: Record<string, string | number | boolean | undefined> = { term };
  if (args.fields) params['fields'] = args.fields as string;
  if (args.exact_match) params['exact_match'] = args.exact_match as boolean;
  if (args.limit) params['limit'] = args.limit as number;
  if (args.cursor) params['cursor'] = args.cursor as string;
  return handleResponse(await apiGet(c, '/api/v2/organizations/search', params));
}

export async function handleCreateOrganization(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  if (!args.name) return { success: false, error: 'name is required' };
  const body: Record<string, unknown> = { name: args.name };
  if (args.owner_id) body['owner_id'] = args.owner_id;
  if (args.address) body['address'] = args.address;
  if (args.visible_to) body['visible_to'] = args.visible_to;
  return handleResponse(await apiPost(c, '/api/v1/organizations', body));
}

export async function handleUpdateOrganization(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.org_id as number;
  if (!id) return { success: false, error: 'org_id is required' };
  const body: Record<string, unknown> = {};
  if (args.name) body['name'] = args.name;
  if (args.owner_id) body['owner_id'] = args.owner_id;
  if (args.address) body['address'] = args.address;
  if (args.visible_to) body['visible_to'] = args.visible_to;
  return handleResponse(await apiPut(c, `/api/v1/organizations/${id}`, body));
}

export async function handleDeleteOrganization(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.org_id as number;
  if (!id) return { success: false, error: 'org_id is required' };
  return handleResponse(await apiDelete(c, `/api/v1/organizations/${id}`));
}

// ─── Leads ────────────────────────────────────────────────────────────────────

export async function handleListLeads(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const params: Record<string, string | number | boolean | undefined> = {};
  if (args.owner_id) params['owner_id'] = args.owner_id as number;
  if (args.person_id) params['person_id'] = args.person_id as number;
  if (args.org_id) params['organization_id'] = args.org_id as number;
  if (args.limit) params['limit'] = args.limit as number;
  if (args.cursor) params['cursor'] = args.cursor as string;
  if (args.sort_by) params['sort_by'] = args.sort_by as string;
  if (args.sort_direction) params['sort_direction'] = args.sort_direction as string;
  return handleResponse(await apiGet(c, '/api/v1/leads', params));
}

export async function handleGetLead(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.lead_id as string;
  if (!id) return { success: false, error: 'lead_id is required' };
  return handleResponse(await apiGet(c, `/api/v1/leads/${id}`));
}

export async function handleCreateLead(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  if (!args.title) return { success: false, error: 'title is required' };
  if (!args.person_id && !args.org_id) return { success: false, error: 'person_id or org_id is required' };
  const body: Record<string, unknown> = { title: args.title };
  if (args.person_id) body['person_id'] = args.person_id;
  if (args.org_id) body['organization_id'] = args.org_id;
  if (args.owner_id) body['owner_id'] = args.owner_id;
  if (args.expected_close_date) body['expected_close_date'] = args.expected_close_date;
  if (args.value !== undefined && args.currency) {
    body['value'] = { amount: args.value, currency: args.currency };
  }
  if (args.label_ids) body['label_ids'] = args.label_ids;
  if (args.custom_fields && typeof args.custom_fields === 'object') {
    Object.assign(body, args.custom_fields as Record<string, unknown>);
  }
  return handleResponse(await apiPost(c, '/api/v1/leads', body));
}

export async function handleUpdateLead(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.lead_id as string;
  if (!id) return { success: false, error: 'lead_id is required' };
  const body: Record<string, unknown> = {};
  if (args.title) body['title'] = args.title;
  if (args.owner_id) body['owner_id'] = args.owner_id;
  if (args.person_id) body['person_id'] = args.person_id;
  if (args.org_id) body['organization_id'] = args.org_id;
  if (args.expected_close_date) body['expected_close_date'] = args.expected_close_date;
  if (args.value !== undefined && args.currency) {
    body['value'] = { amount: args.value, currency: args.currency };
  }
  if (args.label_ids) body['label_ids'] = args.label_ids;
  if (args.was_seen !== undefined) body['was_seen'] = args.was_seen;
  if (args.custom_fields && typeof args.custom_fields === 'object') {
    Object.assign(body, args.custom_fields as Record<string, unknown>);
  }
  return handleResponse(await apiPatch(c, `/api/v1/leads/${id}`, body));
}

export async function handleDeleteLead(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.lead_id as string;
  if (!id) return { success: false, error: 'lead_id is required' };
  return handleResponse(await apiDelete(c, `/api/v1/leads/${id}`));
}

export async function handleConvertLead(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.lead_id as string;
  if (!id) return { success: false, error: 'lead_id is required' };
  // Native lead → deal conversion, preserving person/organization links.
  // Conversion is async: the response carries a `status`
  // (not_started/running/completed/failed/rejected) and a `deal_id` only once
  // completed. Callers can poll conversion status separately if needed.
  return handleResponse(await apiPost(c, `/api/v1/leads/${id}/convert/deal`, {}));
}

// ─── Activities ───────────────────────────────────────────────────────────────

export async function handleListActivities(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const params: Record<string, string | number | boolean | undefined> = {};
  if (args.user_id) params['user_id'] = args.user_id as number;
  if (args.deal_id) params['deal_id'] = args.deal_id as number;
  if (args.person_id) params['person_id'] = args.person_id as number;
  if (args.org_id) params['org_id'] = args.org_id as number;
  if (args.done !== undefined) params['done'] = args.done as number; // 0 or 1
  if (args.type) params['type'] = args.type as string;
  if (args.limit) params['limit'] = args.limit as number;
  if (args.cursor) params['cursor'] = args.cursor as string;
  if (args.start_date) params['start_date'] = args.start_date as string;
  if (args.end_date) params['end_date'] = args.end_date as string;
  if (args.updated_since) params['updated_since'] = args.updated_since as string;
  return handleResponse(await apiGet(c, '/api/v1/activities', params));
}

export async function handleGetActivity(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.activity_id as number;
  if (!id) return { success: false, error: 'activity_id is required' };
  return handleResponse(await apiGet(c, `/api/v1/activities/${id}`));
}

export async function handleCreateActivity(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  if (!args.subject) return { success: false, error: 'subject is required' };
  if (!args.type) return { success: false, error: 'type is required' };
  const body: Record<string, unknown> = {
    subject: args.subject,
    type: args.type,
  };
  if (args.due_date) body['due_date'] = args.due_date;
  if (args.due_time) body['due_time'] = args.due_time;
  if (args.duration) body['duration'] = args.duration;
  if (args.note) body['note'] = args.note;
  if (args.deal_id) body['deal_id'] = args.deal_id;
  if (args.lead_id) body['lead_id'] = args.lead_id;
  if (args.person_id) body['person_id'] = args.person_id;
  if (args.org_id) body['org_id'] = args.org_id;
  if (args.user_id) body['user_id'] = args.user_id;
  if (args.done !== undefined) body['done'] = args.done;
  return handleResponse(await apiPost(c, '/api/v1/activities', body));
}

export async function handleUpdateActivity(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.activity_id as number;
  if (!id) return { success: false, error: 'activity_id is required' };
  const body: Record<string, unknown> = {};
  if (args.subject) body['subject'] = args.subject;
  if (args.type) body['type'] = args.type;
  if (args.due_date) body['due_date'] = args.due_date;
  if (args.due_time) body['due_time'] = args.due_time;
  if (args.duration) body['duration'] = args.duration;
  if (args.note) body['note'] = args.note;
  if (args.deal_id) body['deal_id'] = args.deal_id;
  if (args.lead_id) body['lead_id'] = args.lead_id;
  if (args.person_id) body['person_id'] = args.person_id;
  if (args.org_id) body['org_id'] = args.org_id;
  if (args.user_id) body['user_id'] = args.user_id;
  if (args.done !== undefined) body['done'] = args.done;
  return handleResponse(await apiPut(c, `/api/v1/activities/${id}`, body));
}

export async function handleDeleteActivity(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.activity_id as number;
  if (!id) return { success: false, error: 'activity_id is required' };
  return handleResponse(await apiDelete(c, `/api/v1/activities/${id}`));
}

// ─── Notes ────────────────────────────────────────────────────────────────────

export async function handleListNotes(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const params: Record<string, string | number | boolean | undefined> = {};
  if (args.user_id) params['user_id'] = args.user_id as number;
  if (args.deal_id) params['deal_id'] = args.deal_id as number;
  if (args.person_id) params['person_id'] = args.person_id as number;
  if (args.org_id) params['org_id'] = args.org_id as number;
  if (args.lead_id) params['lead_id'] = args.lead_id as string;
  if (args.limit) params['limit'] = args.limit as number;
  if (args.start) params['start'] = args.start as number;
  if (args.start_date) params['start_date'] = args.start_date as string;
  if (args.end_date) params['end_date'] = args.end_date as string;
  if (args.updated_since) params['updated_since'] = args.updated_since as string;
  return handleResponse(await apiGet(c, '/api/v1/notes', params));
}

export async function handleGetNote(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.note_id as number;
  if (!id) return { success: false, error: 'note_id is required' };
  return handleResponse(await apiGet(c, `/api/v1/notes/${id}`));
}

export async function handleCreateNote(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  if (!args.content) return { success: false, error: 'content is required' };
  const body: Record<string, unknown> = { content: args.content };
  if (args.deal_id) body['deal_id'] = args.deal_id;
  if (args.person_id) body['person_id'] = args.person_id;
  if (args.org_id) body['org_id'] = args.org_id;
  if (args.lead_id) body['lead_id'] = args.lead_id;
  if (args.pinned_to_deal_flag !== undefined) body['pinned_to_deal_flag'] = args.pinned_to_deal_flag ? 1 : 0;
  if (args.pinned_to_person_flag !== undefined) body['pinned_to_person_flag'] = args.pinned_to_person_flag ? 1 : 0;
  if (args.pinned_to_org_flag !== undefined) body['pinned_to_organization_flag'] = args.pinned_to_org_flag ? 1 : 0;
  return handleResponse(await apiPost(c, '/api/v1/notes', body));
}

export async function handleUpdateNote(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.note_id as number;
  if (!id) return { success: false, error: 'note_id is required' };
  const body: Record<string, unknown> = {};
  if (args.content) body['content'] = args.content;
  if (args.deal_id) body['deal_id'] = args.deal_id;
  if (args.person_id) body['person_id'] = args.person_id;
  if (args.org_id) body['org_id'] = args.org_id;
  if (args.lead_id) body['lead_id'] = args.lead_id;
  if (args.pinned_to_deal_flag !== undefined) body['pinned_to_deal_flag'] = args.pinned_to_deal_flag ? 1 : 0;
  if (args.pinned_to_person_flag !== undefined) body['pinned_to_person_flag'] = args.pinned_to_person_flag ? 1 : 0;
  if (args.pinned_to_org_flag !== undefined) body['pinned_to_organization_flag'] = args.pinned_to_org_flag ? 1 : 0;
  return handleResponse(await apiPut(c, `/api/v1/notes/${id}`, body));
}

export async function handleDeleteNote(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.note_id as number;
  if (!id) return { success: false, error: 'note_id is required' };
  return handleResponse(await apiDelete(c, `/api/v1/notes/${id}`));
}

// ─── Pipelines ────────────────────────────────────────────────────────────────

export async function handleListPipelines(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  return handleResponse(await apiGet(c, '/api/v1/pipelines'));
}

export async function handleGetPipeline(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.pipeline_id as number;
  if (!id) return { success: false, error: 'pipeline_id is required' };
  return handleResponse(await apiGet(c, `/api/v1/pipelines/${id}`));
}

export async function handleCreatePipeline(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  if (!args.name) return { success: false, error: 'name is required' };
  const body: Record<string, unknown> = { name: args.name };
  if (args.order_nr !== undefined) body['order_nr'] = args.order_nr;
  if (args.active !== undefined) body['active'] = args.active;
  return handleResponse(await apiPost(c, '/api/v1/pipelines', body));
}

export async function handleUpdatePipeline(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.pipeline_id as number;
  if (!id) return { success: false, error: 'pipeline_id is required' };
  const body: Record<string, unknown> = {};
  if (args.name) body['name'] = args.name;
  if (args.order_nr !== undefined) body['order_nr'] = args.order_nr;
  if (args.active !== undefined) body['active'] = args.active;
  return handleResponse(await apiPut(c, `/api/v1/pipelines/${id}`, body));
}

export async function handleDeletePipeline(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.pipeline_id as number;
  if (!id) return { success: false, error: 'pipeline_id is required' };
  return handleResponse(await apiDelete(c, `/api/v1/pipelines/${id}`));
}

// ─── Stages ───────────────────────────────────────────────────────────────────

export async function handleListStages(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const params: Record<string, string | number | boolean | undefined> = {};
  if (args.pipeline_id) params['pipeline_id'] = args.pipeline_id as number;
  return handleResponse(await apiGet(c, '/api/v1/stages', params));
}

export async function handleGetStage(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.stage_id as number;
  if (!id) return { success: false, error: 'stage_id is required' };
  return handleResponse(await apiGet(c, `/api/v1/stages/${id}`));
}

export async function handleCreateStage(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  if (!args.name) return { success: false, error: 'name is required' };
  if (!args.pipeline_id) return { success: false, error: 'pipeline_id is required' };
  const body: Record<string, unknown> = {
    name: args.name,
    pipeline_id: args.pipeline_id,
  };
  if (args.order_nr !== undefined) body['order_nr'] = args.order_nr;
  if (args.deal_probability !== undefined) body['deal_probability'] = args.deal_probability;
  if (args.rotten_flag !== undefined) body['rotten_flag'] = args.rotten_flag;
  if (args.rotten_days !== undefined) body['rotten_days'] = args.rotten_days;
  return handleResponse(await apiPost(c, '/api/v1/stages', body));
}

export async function handleUpdateStage(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.stage_id as number;
  if (!id) return { success: false, error: 'stage_id is required' };
  const body: Record<string, unknown> = {};
  if (args.name) body['name'] = args.name;
  if (args.pipeline_id) body['pipeline_id'] = args.pipeline_id;
  if (args.order_nr !== undefined) body['order_nr'] = args.order_nr;
  if (args.deal_probability !== undefined) body['deal_probability'] = args.deal_probability;
  if (args.rotten_flag !== undefined) body['rotten_flag'] = args.rotten_flag;
  if (args.rotten_days !== undefined) body['rotten_days'] = args.rotten_days;
  return handleResponse(await apiPut(c, `/api/v1/stages/${id}`, body));
}

export async function handleDeleteStage(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.stage_id as number;
  if (!id) return { success: false, error: 'stage_id is required' };
  return handleResponse(await apiDelete(c, `/api/v1/stages/${id}`));
}

// ─── Products ─────────────────────────────────────────────────────────────────

export async function handleListProducts(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const params: Record<string, string | number | boolean | undefined> = {};
  if (args.limit) params['limit'] = args.limit as number;
  if (args.cursor) params['cursor'] = args.cursor as string;
  if (args.updated_since) params['updated_since'] = args.updated_since as string;
  return handleResponse(await apiGet(c, '/api/v1/products', params));
}

export async function handleGetProduct(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.product_id as number;
  if (!id) return { success: false, error: 'product_id is required' };
  return handleResponse(await apiGet(c, `/api/v1/products/${id}`));
}

export async function handleCreateProduct(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  if (!args.name) return { success: false, error: 'name is required' };
  const body: Record<string, unknown> = { name: args.name };
  if (args.code) body['code'] = args.code;
  if (args.description) body['description'] = args.description;
  if (args.unit) body['unit'] = args.unit;
  if (args.tax !== undefined) body['tax'] = args.tax;
  if (args.active_flag !== undefined) body['active_flag'] = args.active_flag;
  if (args.owner_id) body['owner_id'] = args.owner_id;
  if (args.prices) body['prices'] = args.prices;
  return handleResponse(await apiPost(c, '/api/v1/products', body));
}

export async function handleUpdateProduct(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.product_id as number;
  if (!id) return { success: false, error: 'product_id is required' };
  const body: Record<string, unknown> = {};
  if (args.name) body['name'] = args.name;
  if (args.code) body['code'] = args.code;
  if (args.description) body['description'] = args.description;
  if (args.unit) body['unit'] = args.unit;
  if (args.tax !== undefined) body['tax'] = args.tax;
  if (args.active_flag !== undefined) body['active_flag'] = args.active_flag;
  if (args.owner_id) body['owner_id'] = args.owner_id;
  if (args.prices) body['prices'] = args.prices;
  return handleResponse(await apiPut(c, `/api/v1/products/${id}`, body));
}

export async function handleDeleteProduct(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.product_id as number;
  if (!id) return { success: false, error: 'product_id is required' };
  return handleResponse(await apiDelete(c, `/api/v1/products/${id}`));
}

// ─── Global Search ────────────────────────────────────────────────────────────

export async function handleSearch(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const term = args.term as string;
  if (!term) return { success: false, error: 'term is required' };
  const params: Record<string, string | number | boolean | undefined> = { term };
  if (args.item_types) params['item_types'] = args.item_types as string;
  if (args.fields) params['fields'] = args.fields as string;
  if (args.exact_match) params['exact_match'] = args.exact_match as boolean;
  if (args.limit) params['limit'] = args.limit as number;
  if (args.cursor) params['cursor'] = args.cursor as string;
  return handleResponse(await apiGet(c, '/api/v2/itemSearch', params));
}

// ─── Users ────────────────────────────────────────────────────────────────────

export async function handleListUsers(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  return handleResponse(await apiGet(c, '/api/v1/users'));
}

export async function handleGetCurrentUser(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  return handleResponse(await apiGet(c, '/api/v1/users/me'));
}

// ─── Deal Participants ────────────────────────────────────────────────────────

export async function handleListDealParticipants(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.deal_id as number;
  if (!id) return { success: false, error: 'deal_id is required' };
  const params: Record<string, string | number | boolean | undefined> = {};
  if (args.limit) params['limit'] = args.limit as number;
  if (args.start) params['start'] = args.start as number;
  return handleResponse(await apiGet(c, `/api/v1/deals/${id}/participants`, params));
}

export async function handleAddDealParticipant(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.deal_id as number;
  if (!id) return { success: false, error: 'deal_id is required' };
  if (!args.person_id) return { success: false, error: 'person_id is required' };
  return handleResponse(await apiPost(c, `/api/v1/deals/${id}/participants`, { person_id: args.person_id }));
}

export async function handleDeleteDealParticipant(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const dealId = args.deal_id as number;
  const participantId = args.participant_id as number;
  if (!dealId) return { success: false, error: 'deal_id is required' };
  if (!participantId) return { success: false, error: 'participant_id is required' };
  return handleResponse(await apiDelete(c, `/api/v1/deals/${dealId}/participants/${participantId}`));
}

// ─── Deal Products ────────────────────────────────────────────────────────────

export async function handleListDealProducts(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.deal_id as number;
  if (!id) return { success: false, error: 'deal_id is required' };
  const params: Record<string, string | number | boolean | undefined> = {};
  if (args.limit) params['limit'] = args.limit as number;
  if (args.start) params['start'] = args.start as number;
  return handleResponse(await apiGet(c, `/api/v1/deals/${id}/products`, params));
}

export async function handleAddDealProduct(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.deal_id as number;
  if (!id) return { success: false, error: 'deal_id is required' };
  if (!args.product_id) return { success: false, error: 'product_id is required' };
  if (args.item_price === undefined) return { success: false, error: 'item_price is required' };
  const body: Record<string, unknown> = {
    product_id: args.product_id,
    item_price: args.item_price,
  };
  if (args.quantity !== undefined) body['quantity'] = args.quantity;
  if (args.discount !== undefined) body['discount'] = args.discount;
  if (args.discount_type) body['discount_type'] = args.discount_type;
  if (args.tax !== undefined) body['tax'] = args.tax;
  if (args.comments) body['comments'] = args.comments;
  return handleResponse(await apiPost(c, `/api/v1/deals/${id}/products`, body));
}

export async function handleUpdateDealProduct(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const dealId = args.deal_id as number;
  const productAttachmentId = args.product_attachment_id as number;
  if (!dealId) return { success: false, error: 'deal_id is required' };
  if (!productAttachmentId) return { success: false, error: 'product_attachment_id is required' };
  const body: Record<string, unknown> = {};
  if (args.item_price !== undefined) body['item_price'] = args.item_price;
  if (args.quantity !== undefined) body['quantity'] = args.quantity;
  if (args.discount !== undefined) body['discount'] = args.discount;
  if (args.discount_type) body['discount_type'] = args.discount_type;
  if (args.tax !== undefined) body['tax'] = args.tax;
  if (args.comments) body['comments'] = args.comments;
  if (args.enabled_flag !== undefined) body['enabled_flag'] = args.enabled_flag;
  return handleResponse(await apiPut(c, `/api/v1/deals/${dealId}/products/${productAttachmentId}`, body));
}

export async function handleDeleteDealProduct(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const dealId = args.deal_id as number;
  const productAttachmentId = args.product_attachment_id as number;
  if (!dealId) return { success: false, error: 'deal_id is required' };
  if (!productAttachmentId) return { success: false, error: 'product_attachment_id is required' };
  return handleResponse(await apiDelete(c, `/api/v1/deals/${dealId}/products/${productAttachmentId}`));
}

// ─── Activity Types ───────────────────────────────────────────────────────────

export async function handleListActivityTypes(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  return handleResponse(await apiGet(c, '/api/v1/activityTypes'));
}

// ─── Custom Fields ────────────────────────────────────────────────────────────

export async function handleListDealFields(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  return handleResponse(await apiGet(c, '/api/v1/dealFields'));
}

export async function handleListPersonFields(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  return handleResponse(await apiGet(c, '/api/v1/personFields'));
}

export async function handleListOrganizationFields(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  return handleResponse(await apiGet(c, '/api/v1/organizationFields'));
}

export async function handleListProductFields(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  return handleResponse(await apiGet(c, '/api/v1/productFields'));
}

// ─── Currencies ───────────────────────────────────────────────────────────────

export async function handleListCurrencies(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const params: Record<string, string | number | boolean | undefined> = {};
  if (args.term) params['term'] = args.term as string;
  return handleResponse(await apiGet(c, '/api/v1/currencies', params));
}

// ─── Filters ─────────────────────────────────────────────────────────────────

export async function handleListFilters(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const params: Record<string, string | number | boolean | undefined> = {};
  if (args.type) params['type'] = args.type as string;
  return handleResponse(await apiGet(c, '/api/v1/filters', params));
}

export async function handleGetFilter(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.filter_id as number;
  if (!id) return { success: false, error: 'filter_id is required' };
  return handleResponse(await apiGet(c, `/api/v1/filters/${id}`));
}

export async function handleDeleteFilter(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.filter_id as number;
  if (!id) return { success: false, error: 'filter_id is required' };
  return handleResponse(await apiDelete(c, `/api/v1/filters/${id}`));
}

// ─── Goals ────────────────────────────────────────────────────────────────────

export async function handleListGoals(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const params: Record<string, string | number | boolean | undefined> = {};
  if (args.type_name) params['type_name'] = args.type_name as string;
  if (args.assignee_id) params['assignee_id'] = args.assignee_id as number;
  if (args.assignee_type) params['assignee_type'] = args.assignee_type as string;
  if (args.expected_outcome_target) params['expected_outcome_target'] = args.expected_outcome_target as number;
  if (args.expected_outcome_currency) params['expected_outcome_currency'] = args.expected_outcome_currency as string;
  if (args.is_active !== undefined) params['is_active'] = args.is_active as boolean;
  return handleResponse(await apiGet(c, '/api/v1/goals/find', params));
}

export async function handleAddGoal(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  if (!args.title) return { success: false, error: 'title is required' };
  const body: Record<string, unknown> = { title: args.title };
  if (args.assignee) body['assignee'] = args.assignee;
  if (args.type) body['type'] = args.type;
  if (args.expected_outcome) body['expected_outcome'] = args.expected_outcome;
  if (args.duration) body['duration'] = args.duration;
  if (args.interval) body['interval'] = args.interval;
  return handleResponse(await apiPost(c, '/api/v1/goals', body));
}

export async function handleUpdateGoal(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.goal_id as string;
  if (!id) return { success: false, error: 'goal_id is required' };
  const body: Record<string, unknown> = {};
  if (args.title) body['title'] = args.title;
  if (args.assignee) body['assignee'] = args.assignee;
  if (args.type) body['type'] = args.type;
  if (args.expected_outcome) body['expected_outcome'] = args.expected_outcome;
  if (args.duration) body['duration'] = args.duration;
  if (args.interval) body['interval'] = args.interval;
  return handleResponse(await apiPut(c, `/api/v1/goals/${id}`, body));
}

export async function handleDeleteGoal(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.goal_id as string;
  if (!id) return { success: false, error: 'goal_id is required' };
  return handleResponse(await apiDelete(c, `/api/v1/goals/${id}`));
}

// ─── Projects ─────────────────────────────────────────────────────────────────

export async function handleListProjects(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const params: Record<string, string | number | boolean | undefined> = {};
  if (args.status) params['status'] = args.status as string;
  if (args.phase_id) params['phase_id'] = args.phase_id as number;
  if (args.deal_id) params['deal_id'] = args.deal_id as number;
  if (args.person_id) params['person_id'] = args.person_id as number;
  if (args.org_id) params['org_id'] = args.org_id as number;
  if (args.limit) params['limit'] = args.limit as number;
  if (args.cursor) params['cursor'] = args.cursor as string;
  return handleResponse(await apiGet(c, '/api/v2/projects', params));
}

export async function handleGetProject(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.project_id as number;
  if (!id) return { success: false, error: 'project_id is required' };
  return handleResponse(await apiGet(c, `/api/v2/projects/${id}`));
}

export async function handleCreateProject(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  if (!args.title) return { success: false, error: 'title is required' };
  const body: Record<string, unknown> = { title: args.title };
  if (args.board_id) body['board_id'] = args.board_id;
  if (args.phase_id) body['phase_id'] = args.phase_id;
  if (args.description) body['description'] = args.description;
  if (args.status) body['status'] = args.status;
  if (args.owner_id) body['owner_id'] = args.owner_id;
  if (args.start_date) body['start_date'] = args.start_date;
  if (args.end_date) body['end_date'] = args.end_date;
  if (args.deal_ids) body['deal_ids'] = args.deal_ids;
  if (args.person_ids) body['person_ids'] = args.person_ids;
  if (args.org_ids) body['org_ids'] = args.org_ids;
  return handleResponse(await apiPost(c, '/api/v2/projects', body));
}

export async function handleUpdateProject(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.project_id as number;
  if (!id) return { success: false, error: 'project_id is required' };
  const body: Record<string, unknown> = {};
  if (args.title) body['title'] = args.title;
  if (args.board_id) body['board_id'] = args.board_id;
  if (args.phase_id) body['phase_id'] = args.phase_id;
  if (args.description) body['description'] = args.description;
  if (args.status) body['status'] = args.status;
  if (args.owner_id) body['owner_id'] = args.owner_id;
  if (args.start_date) body['start_date'] = args.start_date;
  if (args.end_date) body['end_date'] = args.end_date;
  return handleResponse(await apiPatch(c, `/api/v2/projects/${id}`, body));
}

export async function handleDeleteProject(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.project_id as number;
  if (!id) return { success: false, error: 'project_id is required' };
  return handleResponse(await apiDelete(c, `/api/v2/projects/${id}`));
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

export async function handleListTasks(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const params: Record<string, string | number | boolean | undefined> = {};
  if (args.is_done !== undefined) params['is_done'] = args.is_done as boolean;
  if (args.is_milestone !== undefined) params['is_milestone'] = args.is_milestone as boolean;
  if (args.assignee_id) params['assignee_id'] = args.assignee_id as number;
  if (args.project_id) params['project_id'] = args.project_id as number;
  if (args.parent_task_id !== undefined) params['parent_task_id'] = args.parent_task_id as string;
  if (args.limit) params['limit'] = args.limit as number;
  if (args.cursor) params['cursor'] = args.cursor as string;
  return handleResponse(await apiGet(c, '/api/v2/tasks', params));
}

export async function handleGetTask(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.task_id as number;
  if (!id) return { success: false, error: 'task_id is required' };
  return handleResponse(await apiGet(c, `/api/v2/tasks/${id}`));
}

export async function handleCreateTask(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  if (!args.title) return { success: false, error: 'title is required' };
  if (!args.project_id) return { success: false, error: 'project_id is required' };
  const body: Record<string, unknown> = {
    title: args.title,
    project_id: args.project_id,
  };
  if (args.description) body['description'] = args.description;
  if (args.assignee_id) body['assignee_id'] = args.assignee_id;
  if (args.due_date) body['due_date'] = args.due_date;
  if (args.is_milestone !== undefined) body['is_milestone'] = args.is_milestone;
  if (args.parent_task_id) body['parent_task_id'] = args.parent_task_id;
  return handleResponse(await apiPost(c, '/api/v2/tasks', body));
}

export async function handleUpdateTask(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.task_id as number;
  if (!id) return { success: false, error: 'task_id is required' };
  const body: Record<string, unknown> = {};
  if (args.title) body['title'] = args.title;
  if (args.description) body['description'] = args.description;
  if (args.assignee_id) body['assignee_id'] = args.assignee_id;
  if (args.due_date) body['due_date'] = args.due_date;
  if (args.is_done !== undefined) body['is_done'] = args.is_done;
  if (args.is_milestone !== undefined) body['is_milestone'] = args.is_milestone;
  return handleResponse(await apiPatch(c, `/api/v2/tasks/${id}`, body));
}

export async function handleDeleteTask(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.task_id as number;
  if (!id) return { success: false, error: 'task_id is required' };
  return handleResponse(await apiDelete(c, `/api/v2/tasks/${id}`));
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export async function handleListWebhooks(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  return handleResponse(await apiGet(c, '/api/v1/webhooks'));
}

export async function handleCreateWebhook(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  if (!args.subscription_url) return { success: false, error: 'subscription_url is required' };
  if (!args.event_action) return { success: false, error: 'event_action is required' };
  if (!args.event_object) return { success: false, error: 'event_object is required' };
  const body: Record<string, unknown> = {
    subscription_url: args.subscription_url,
    event_action: args.event_action,
    event_object: args.event_object,
  };
  if (args.user_id) body['user_id'] = args.user_id;
  if (args.http_auth_user) body['http_auth_user'] = args.http_auth_user;
  if (args.http_auth_password) body['http_auth_password'] = args.http_auth_password;
  return handleResponse(await apiPost(c, '/api/v1/webhooks', body));
}

export async function handleDeleteWebhook(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.webhook_id as number;
  if (!id) return { success: false, error: 'webhook_id is required' };
  return handleResponse(await apiDelete(c, `/api/v1/webhooks/${id}`));
}

// ─── Organization Relationships ───────────────────────────────────────────────

export async function handleListOrgRelationships(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.org_id as number;
  if (!id) return { success: false, error: 'org_id is required' };
  return handleResponse(await apiGet(c, '/api/v1/organizationRelationships', { org_id: id }));
}

export async function handleCreateOrgRelationship(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  if (!args.org_id) return { success: false, error: 'org_id is required' };
  if (!args.type) return { success: false, error: 'type is required (parent, subsidiary, or related)' };
  if (!args.rel_owner_org_id) return { success: false, error: 'rel_owner_org_id is required' };
  if (!args.rel_linked_org_id) return { success: false, error: 'rel_linked_org_id is required' };
  const body: Record<string, unknown> = {
    org_id: args.org_id,
    type: args.type,
    rel_owner_org_id: args.rel_owner_org_id,
    rel_linked_org_id: args.rel_linked_org_id,
  };
  return handleResponse(await apiPost(c, '/api/v1/organizationRelationships', body));
}

export async function handleDeleteOrgRelationship(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.relationship_id as number;
  if (!id) return { success: false, error: 'relationship_id is required' };
  return handleResponse(await apiDelete(c, `/api/v1/organizationRelationships/${id}`));
}

// ─── Files ────────────────────────────────────────────────────────────────────

export async function handleListFiles(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const params: Record<string, string | number | boolean | undefined> = {};
  if (args.limit) params['limit'] = args.limit as number;
  if (args.start) params['start'] = args.start as number;
  if (args.sort) params['sort'] = args.sort as string;
  return handleResponse(await apiGet(c, '/api/v1/files', params));
}

export async function handleGetFile(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.file_id as number;
  if (!id) return { success: false, error: 'file_id is required' };
  return handleResponse(await apiGet(c, `/api/v1/files/${id}`));
}

export async function handleDeleteFile(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.file_id as number;
  if (!id) return { success: false, error: 'file_id is required' };
  return handleResponse(await apiDelete(c, `/api/v1/files/${id}`));
}

// ─── Person ↔ Organization Relationships ─────────────────────────────────────

export async function handleListPersonDeals(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.person_id as number;
  if (!id) return { success: false, error: 'person_id is required' };
  const params: Record<string, string | number | boolean | undefined> = {};
  if (args.status) params['status'] = args.status as string;
  if (args.limit) params['limit'] = args.limit as number;
  if (args.start) params['start'] = args.start as number;
  return handleResponse(await apiGet(c, `/api/v1/persons/${id}/deals`, params));
}

export async function handleListOrganizationDeals(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.org_id as number;
  if (!id) return { success: false, error: 'org_id is required' };
  const params: Record<string, string | number | boolean | undefined> = {};
  if (args.status) params['status'] = args.status as string;
  if (args.limit) params['limit'] = args.limit as number;
  if (args.start) params['start'] = args.start as number;
  return handleResponse(await apiGet(c, `/api/v1/organizations/${id}/deals`, params));
}

export async function handleListOrganizationPersons(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.org_id as number;
  if (!id) return { success: false, error: 'org_id is required' };
  const params: Record<string, string | number | boolean | undefined> = {};
  if (args.limit) params['limit'] = args.limit as number;
  if (args.start) params['start'] = args.start as number;
  return handleResponse(await apiGet(c, `/api/v1/organizations/${id}/persons`, params));
}

// ─── Deal Activities & Notes (sub-resources) ─────────────────────────────────

export async function handleListDealActivities(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.deal_id as number;
  if (!id) return { success: false, error: 'deal_id is required' };
  const params: Record<string, string | number | boolean | undefined> = {};
  if (args.done !== undefined) params['done'] = args.done as number;
  if (args.limit) params['limit'] = args.limit as number;
  if (args.start) params['start'] = args.start as number;
  return handleResponse(await apiGet(c, `/api/v1/deals/${id}/activities`, params));
}

export async function handleListDealNotes(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const id = args.deal_id as number;
  if (!id) return { success: false, error: 'deal_id is required' };
  return handleResponse(await apiGet(c, '/api/v1/notes', { deal_id: id }));
}
