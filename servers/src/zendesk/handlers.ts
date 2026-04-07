/**
 * Zendesk MCP Server Tool Handlers
 *
 * Uses the Zendesk REST API v2 (email/token Basic auth).
 */

import type { ServerContext, ToolResult } from '../common/types.js';

export interface ZendeskContext extends ServerContext {
  /** base64-encoded Basic auth string */
  basicAuth: string;
  /** Zendesk subdomain, e.g. "mycompany" */
  subdomain: string;
}

function apiRequest(
  context: ZendeskContext,
  path: string,
  params?: Record<string, string | number | undefined>
): Promise<Response> {
  let url = `https://${context.subdomain}.zendesk.com/api/v2${path}`;
  if (params) {
    const query = Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    if (query) url += `?${query}`;
  }
  return fetch(url, {
    headers: {
      Authorization: `Basic ${context.basicAuth}`,
      'Content-Type': 'application/json',
    },
  });
}

async function apiPost(
  context: ZendeskContext,
  path: string,
  body: unknown
): Promise<Response> {
  return fetch(`https://${context.subdomain}.zendesk.com/api/v2${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${context.basicAuth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function apiPut(
  context: ZendeskContext,
  path: string,
  body: unknown
): Promise<Response> {
  return fetch(`https://${context.subdomain}.zendesk.com/api/v2${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Basic ${context.basicAuth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function ctx(context: ServerContext): ZendeskContext {
  return context as ZendeskContext;
}

/**
 * List tickets (defaults to recent open tickets)
 */
export async function handleListTickets(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const params: Record<string, string | number | undefined> = {};
  if (args.status) params['status'] = args.status as string;
  if (args.page) params['page'] = args.page as number;
  if (args.per_page) params['per_page'] = args.per_page as number;
  if (args.sort_by) params['sort_by'] = args.sort_by as string;
  if (args.sort_order) params['sort_order'] = args.sort_order as string;

  const response = await apiRequest(c, '/tickets.json', params);
  if (!response.ok) {
    return { success: false, error: `API error: ${response.status} ${response.statusText}` };
  }
  const data = await response.json() as Record<string, unknown>;
  return { success: true, data };
}

/**
 * Get a single ticket by ID
 */
export async function handleGetTicket(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const ticketId = args.ticket_id as string | number;
  if (!ticketId) return { success: false, error: 'ticket_id is required' };

  const response = await apiRequest(c, `/tickets/${ticketId}.json`);
  if (!response.ok) {
    return { success: false, error: `API error: ${response.status} ${response.statusText}` };
  }
  const data = await response.json() as Record<string, unknown>;
  return { success: true, data };
}

/**
 * Search tickets using Zendesk search syntax
 */
export async function handleSearchTickets(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const query = args.query as string;
  if (!query) return { success: false, error: 'query is required' };

  const params: Record<string, string | number | undefined> = {
    query: `type:ticket ${query}`,
  };
  if (args.page) params['page'] = args.page as number;
  if (args.per_page) params['per_page'] = args.per_page as number;
  if (args.sort_by) params['sort_by'] = args.sort_by as string;
  if (args.sort_order) params['sort_order'] = args.sort_order as string;

  const response = await apiRequest(c, '/search.json', params);
  if (!response.ok) {
    return { success: false, error: `API error: ${response.status} ${response.statusText}` };
  }
  const data = await response.json() as Record<string, unknown>;
  return { success: true, data };
}

/**
 * List all comments (the full conversation thread) for a ticket
 */
export async function handleListTicketComments(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const ticketId = args.ticket_id as string | number;
  if (!ticketId) return { success: false, error: 'ticket_id is required' };

  const response = await apiRequest(c, `/tickets/${ticketId}/comments.json`);
  if (!response.ok) {
    return { success: false, error: `API error: ${response.status} ${response.statusText}` };
  }
  const data = await response.json() as Record<string, unknown>;
  return { success: true, data };
}

/**
 * Create a new support ticket
 */
export async function handleCreateTicket(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const subject = args.subject as string;
  const body = args.body as string;
  if (!subject) return { success: false, error: 'subject is required' };
  if (!body) return { success: false, error: 'body is required' };

  const ticket: Record<string, unknown> = {
    subject,
    comment: { body },
  };
  if (args.priority) ticket['priority'] = args.priority;
  if (args.type) ticket['type'] = args.type;
  if (args.tags) ticket['tags'] = args.tags;
  if (args.requester_email) {
    ticket['requester'] = { email: args.requester_email, name: args.requester_name ?? args.requester_email };
  }
  if (args.assignee_email) ticket['assignee_email'] = args.assignee_email;

  const response = await apiPost(c, '/tickets.json', { ticket });
  if (!response.ok) {
    return { success: false, error: `API error: ${response.status} ${response.statusText}` };
  }
  const data = await response.json() as Record<string, unknown>;
  return { success: true, data };
}

/**
 * Update a ticket (status, priority, assignee, add a comment, etc.)
 */
export async function handleUpdateTicket(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const c = ctx(context);
  const ticketId = args.ticket_id as string | number;
  if (!ticketId) return { success: false, error: 'ticket_id is required' };

  const ticket: Record<string, unknown> = {};
  if (args.status) ticket['status'] = args.status;
  if (args.priority) ticket['priority'] = args.priority;
  if (args.assignee_email) ticket['assignee_email'] = args.assignee_email;
  if (args.tags) ticket['tags'] = args.tags;
  if (args.subject) ticket['subject'] = args.subject;
  if (args.comment) {
    ticket['comment'] = {
      body: args.comment,
      public: args.comment_public !== false,
    };
  }

  const response = await apiPut(c, `/tickets/${ticketId}.json`, { ticket });
  if (!response.ok) {
    return { success: false, error: `API error: ${response.status} ${response.statusText}` };
  }
  const data = await response.json() as Record<string, unknown>;
  return { success: true, data };
}
