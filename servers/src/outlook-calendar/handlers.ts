/**
 * Outlook Calendar MCP Server Tool Handlers
 *
 * Uses the Microsoft Graph API with an OAuth2 access token.
 */

import type { ServerContext, ToolResult } from '../common/types.js';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';

/**
 * Make an authenticated Microsoft Graph API request
 */
async function graphRequest(
  context: ServerContext,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = context.accessToken;
  if (!token) {
    throw new Error('No Microsoft access token available');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> ?? {}),
  };

  return fetch(`${GRAPH_API}${path}`, { ...options, headers });
}

async function handleError(response: Response): Promise<ToolResult> {
  const body = await response.json().catch(() => ({ error: { message: response.statusText } }));
  return { success: false, error: `Graph API error (${response.status}): ${body.error?.message || response.statusText}` };
}

function formatEvent(event: any) {
  return {
    id: event.id,
    subject: event.subject,
    organizer: event.organizer?.emailAddress,
    start: event.start,
    end: event.end,
    location: event.location?.displayName,
    isAllDay: event.isAllDay,
    isCancelled: event.isCancelled,
    webLink: event.webLink,
    attendees: event.attendees?.map((a: any) => ({
      email: a.emailAddress?.address,
      name: a.emailAddress?.name,
      status: a.status?.response,
    })),
    bodyPreview: event.bodyPreview,
    onlineMeetingUrl: event.onlineMeeting?.joinUrl,
  };
}

// ============================================================================
// Calendar list tools
// ============================================================================

export async function handleListCalendars(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const response = await graphRequest(context, '/me/calendars?$top=50');
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return {
    success: true,
    data: data.value?.map((c: any) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      isDefaultCalendar: c.isDefaultCalendar,
      canEdit: c.canEdit,
      owner: c.owner?.address,
    })),
  };
}

// ============================================================================
// Event tools
// ============================================================================

export async function handleListEvents(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const top = Math.min((args.maxResults as number) || 10, 100);
  const calendarId = args.calendarId as string | undefined;

  const params = new URLSearchParams({
    $top: String(top),
    $orderby: 'start/dateTime',
  });

  if (args.startDateTime) params.set('$filter', `start/dateTime ge '${args.startDateTime}'`);
  if (args.startDateTime && args.endDateTime) {
    params.set('$filter', `start/dateTime ge '${args.startDateTime}' and end/dateTime le '${args.endDateTime}'`);
  }

  const basePath = calendarId
    ? `/me/calendars/${calendarId}/events`
    : '/me/events';

  const response = await graphRequest(context, `${basePath}?${params}`);
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return { success: true, data: data.value?.map(formatEvent) };
}

export async function handleGetEvent(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const eventId = args.eventId as string;

  const response = await graphRequest(context, `/me/events/${eventId}`);
  if (!response.ok) return handleError(response);

  const event = await response.json();
  return { success: true, data: { ...formatEvent(event), body: event.body?.content } };
}

export async function handleSearchEvents(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const query = args.query as string;
  const top = Math.min((args.maxResults as number) || 20, 100);

  // Graph API does not support $search on Events (returns 501).
  // Use $filter with contains() on subject instead.
  const escaped = query.replace(/'/g, "''");
  const filter = `contains(subject,'${escaped}')`;

  const params = new URLSearchParams({
    $filter: filter,
    $top: String(top),
    $orderby: 'start/dateTime asc',
  });

  const response = await graphRequest(context, `/me/events?${params}`);
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return { success: true, data: data.value?.map(formatEvent) };
}

export async function handleCreateEvent(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const calendarId = args.calendarId as string | undefined;

  const event: any = {
    subject: args.subject,
    start: {
      dateTime: args.startDateTime,
      timeZone: (args.timeZone as string) || 'UTC',
    },
    end: {
      dateTime: args.endDateTime,
      timeZone: (args.timeZone as string) || 'UTC',
    },
  };

  if (args.body) event.body = { contentType: 'Text', content: args.body };
  if (args.htmlBody) event.body = { contentType: 'HTML', content: args.htmlBody };
  if (args.location) event.location = { displayName: args.location };
  if (args.isAllDay) event.isAllDay = true;
  if (args.isOnlineMeeting) event.isOnlineMeeting = true;

  if (args.attendees) {
    event.attendees = (args.attendees as string[]).map((email) => ({
      emailAddress: { address: email },
      type: 'required',
    }));
  }

  if (args.recurrence) {
    event.recurrence = args.recurrence;
  }

  const basePath = calendarId
    ? `/me/calendars/${calendarId}/events`
    : '/me/events';

  const response = await graphRequest(context, basePath, {
    method: 'POST',
    body: JSON.stringify(event),
  });
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return { success: true, data: formatEvent(data) };
}

export async function handleUpdateEvent(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const eventId = args.eventId as string;

  const updates: any = {};
  if (args.subject) updates.subject = args.subject;
  if (args.body) updates.body = { contentType: 'Text', content: args.body };
  if (args.location) updates.location = { displayName: args.location };
  if (args.startDateTime) {
    updates.start = { dateTime: args.startDateTime, timeZone: (args.timeZone as string) || 'UTC' };
  }
  if (args.endDateTime) {
    updates.end = { dateTime: args.endDateTime, timeZone: (args.timeZone as string) || 'UTC' };
  }
  if (args.attendees) {
    updates.attendees = (args.attendees as string[]).map((email) => ({
      emailAddress: { address: email },
      type: 'required',
    }));
  }

  const response = await graphRequest(context, `/me/events/${eventId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return { success: true, data: formatEvent(data) };
}

export async function handleDeleteEvent(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const eventId = args.eventId as string;

  const response = await graphRequest(context, `/me/events/${eventId}`, {
    method: 'DELETE',
  });

  if (!response.ok && response.status !== 204) return handleError(response);

  return { success: true, data: { deleted: true, eventId } };
}

export async function handleRespondToEvent(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const eventId = args.eventId as string;
  const responseType = args.response as 'accept' | 'tentativelyAccept' | 'decline';
  const comment = args.comment as string | undefined;

  const body: any = { sendResponse: true };
  if (comment) body.comment = comment;

  const response = await graphRequest(context, `/me/events/${eventId}/${responseType}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!response.ok && response.status !== 202) return handleError(response);

  return { success: true, data: { responded: responseType, eventId } };
}

export async function handleGetFreeBusy(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const schedules = args.schedules as string[];
  const startDateTime = args.startDateTime as string;
  const endDateTime = args.endDateTime as string;
  const timeZone = (args.timeZone as string) || 'UTC';

  const response = await graphRequest(context, '/me/calendar/getSchedule', {
    method: 'POST',
    body: JSON.stringify({
      schedules,
      startTime: { dateTime: startDateTime, timeZone },
      endTime: { dateTime: endDateTime, timeZone },
      availabilityViewInterval: (args.intervalMinutes as number) || 30,
    }),
  });
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return {
    success: true,
    data: data.value?.map((s: any) => ({
      scheduleId: s.scheduleId,
      availabilityView: s.availabilityView,
      items: s.scheduleItems?.map((item: any) => ({
        status: item.status,
        subject: item.subject,
        start: item.start,
        end: item.end,
      })),
    })),
  };
}
