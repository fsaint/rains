/**
 * Google Calendar MCP Server Tool Handlers
 */

import { google, type calendar_v3 } from 'googleapis';
import type { ServerContext, ToolResult } from '../common/types.js';

type CalendarClient = calendar_v3.Calendar;

/**
 * Get Calendar client from context
 */
function getCalendarClient(context: ServerContext): CalendarClient {
  if (!context.accessToken) {
    throw new Error('No access token available');
  }

  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: context.accessToken });
  return google.calendar({ version: 'v3', auth });
}

/**
 * Format event for output
 */
function formatEvent(event: calendar_v3.Schema$Event) {
  return {
    id: event.id,
    summary: event.summary,
    description: event.description,
    location: event.location,
    start: event.start?.dateTime ?? event.start?.date,
    end: event.end?.dateTime ?? event.end?.date,
    allDay: !!event.start?.date,
    attendees: event.attendees?.map((a) => ({
      email: a.email,
      displayName: a.displayName,
      responseStatus: a.responseStatus,
      organizer: a.organizer,
    })),
    organizer: event.organizer,
    status: event.status,
    htmlLink: event.htmlLink,
    hangoutLink: event.hangoutLink,
    conferenceData: event.conferenceData,
    created: event.created,
    updated: event.updated,
    recurrence: event.recurrence,
  };
}

/**
 * List events handler
 */
export async function handleListEvents(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const calendar = getCalendarClient(context);

  const calendarId = (args.calendarId as string) ?? 'primary';
  const timeMin = (args.timeMin as string) ?? new Date().toISOString();
  const timeMax = args.timeMax as string | undefined;
  const maxResults = Math.min((args.maxResults as number) ?? 10, 250);
  const singleEvents = args.singleEvents as boolean ?? true;
  const orderBy = (args.orderBy as string) ?? 'startTime';
  const pageToken = args.pageToken as string | undefined;

  const response = await calendar.events.list({
    calendarId,
    timeMin,
    timeMax,
    maxResults,
    singleEvents,
    orderBy: singleEvents ? orderBy : undefined,
    pageToken,
  });

  const events = (response.data.items ?? []).map(formatEvent);

  return {
    success: true,
    data: {
      events,
      nextPageToken: response.data.nextPageToken,
      summary: response.data.summary,
      timeZone: response.data.timeZone,
    },
  };
}

/**
 * Get event handler
 */
export async function handleGetEvent(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const calendar = getCalendarClient(context);

  const calendarId = (args.calendarId as string) ?? 'primary';
  const eventId = args.eventId as string;

  const response = await calendar.events.get({
    calendarId,
    eventId,
  });

  return {
    success: true,
    data: formatEvent(response.data),
  };
}

/**
 * Search events handler
 */
export async function handleSearchEvents(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const calendar = getCalendarClient(context);

  const query = args.query as string;
  const calendarId = (args.calendarId as string) ?? 'primary';
  const timeMin = args.timeMin as string | undefined;
  const timeMax = args.timeMax as string | undefined;
  const maxResults = Math.min((args.maxResults as number) ?? 20, 250);

  const response = await calendar.events.list({
    calendarId,
    q: query,
    timeMin,
    timeMax,
    maxResults,
    singleEvents: true,
    orderBy: 'startTime',
  });

  const events = (response.data.items ?? []).map(formatEvent);

  return {
    success: true,
    data: {
      query,
      events,
      total: events.length,
    },
  };
}

/**
 * Create event handler
 */
export async function handleCreateEvent(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const calendar = getCalendarClient(context);

  const calendarId = (args.calendarId as string) ?? 'primary';
  const summary = args.summary as string;
  const description = args.description as string | undefined;
  const location = args.location as string | undefined;
  const startTime = args.startTime as string | undefined;
  const endTime = args.endTime as string | undefined;
  const allDay = args.allDay as boolean | undefined;
  const startDate = args.startDate as string | undefined;
  const endDate = args.endDate as string | undefined;
  const attendees = args.attendees as string[] | undefined;
  const recurrence = args.recurrence as string[] | undefined;
  const reminders = args.reminders as { useDefault?: boolean; overrides?: Array<{ method?: string; minutes?: number }> } | undefined;
  const conferenceData = args.conferenceData as boolean | undefined;
  const sendUpdates = (args.sendUpdates as string) ?? 'all';

  // Build event object
  const event: calendar_v3.Schema$Event = {
    summary,
    description,
    location,
    recurrence,
    reminders,
  };

  // Set start/end times
  if (allDay || startDate) {
    event.start = { date: startDate ?? startTime?.split('T')[0] };
    event.end = { date: endDate ?? endTime?.split('T')[0] ?? event.start.date };
  } else if (startTime) {
    event.start = { dateTime: startTime };
    event.end = {
      dateTime: endTime ?? new Date(new Date(startTime).getTime() + 60 * 60 * 1000).toISOString(),
    };
  } else {
    // Default to 1 hour from now
    const now = new Date();
    const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000);
    event.start = { dateTime: now.toISOString() };
    event.end = { dateTime: oneHourLater.toISOString() };
  }

  // Add attendees
  if (attendees?.length) {
    event.attendees = attendees.map((email) => ({ email }));
  }

  // Add conference data
  if (conferenceData) {
    event.conferenceData = {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }

  const response = await calendar.events.insert({
    calendarId,
    requestBody: event,
    sendUpdates: sendUpdates as 'all' | 'externalOnly' | 'none',
    conferenceDataVersion: conferenceData ? 1 : 0,
  });

  return {
    success: true,
    data: {
      ...formatEvent(response.data),
      message: 'Event created successfully',
    },
  };
}

/**
 * Update event handler
 */
export async function handleUpdateEvent(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const calendar = getCalendarClient(context);

  const calendarId = (args.calendarId as string) ?? 'primary';
  const eventId = args.eventId as string;
  const sendUpdates = (args.sendUpdates as string) ?? 'all';

  // Get existing event
  const existing = await calendar.events.get({
    calendarId,
    eventId,
  });

  // Build updated event
  const event: calendar_v3.Schema$Event = { ...existing.data };

  if (args.summary !== undefined) event.summary = args.summary as string;
  if (args.description !== undefined) event.description = args.description as string;
  if (args.location !== undefined) event.location = args.location as string;

  if (args.startTime !== undefined) {
    event.start = { dateTime: args.startTime as string };
  }
  if (args.endTime !== undefined) {
    event.end = { dateTime: args.endTime as string };
  }

  if (args.attendees !== undefined) {
    event.attendees = (args.attendees as string[]).map((email) => ({ email }));
  }

  const response = await calendar.events.update({
    calendarId,
    eventId,
    requestBody: event,
    sendUpdates: sendUpdates as 'all' | 'externalOnly' | 'none',
  });

  return {
    success: true,
    data: {
      ...formatEvent(response.data),
      message: 'Event updated successfully',
    },
  };
}

/**
 * Delete event handler
 */
export async function handleDeleteEvent(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const calendar = getCalendarClient(context);

  const calendarId = (args.calendarId as string) ?? 'primary';
  const eventId = args.eventId as string;
  const sendUpdates = (args.sendUpdates as string) ?? 'all';

  await calendar.events.delete({
    calendarId,
    eventId,
    sendUpdates: sendUpdates as 'all' | 'externalOnly' | 'none',
  });

  return {
    success: true,
    data: {
      eventId,
      message: 'Event deleted successfully',
    },
  };
}

/**
 * List calendars handler
 */
export async function handleListCalendars(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const calendar = getCalendarClient(context);

  const showHidden = args.showHidden as boolean | undefined;
  const showDeleted = args.showDeleted as boolean | undefined;

  const response = await calendar.calendarList.list({
    showHidden,
    showDeleted,
  });

  const calendars = (response.data.items ?? []).map((cal) => ({
    id: cal.id,
    summary: cal.summary,
    description: cal.description,
    primary: cal.primary,
    accessRole: cal.accessRole,
    backgroundColor: cal.backgroundColor,
    foregroundColor: cal.foregroundColor,
    timeZone: cal.timeZone,
  }));

  return {
    success: true,
    data: { calendars },
  };
}

/**
 * Get free/busy handler
 */
export async function handleGetFreeBusy(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const calendar = getCalendarClient(context);

  const timeMin = args.timeMin as string;
  const timeMax = args.timeMax as string;
  const calendarIds = (args.calendarIds as string[]) ?? ['primary'];

  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      items: calendarIds.map((id) => ({ id })),
    },
  });

  const busyTimes: Record<string, { start: string; end: string }[]> = {};
  for (const [calId, data] of Object.entries(response.data.calendars ?? {})) {
    busyTimes[calId] = (data.busy ?? []).map((b) => ({
      start: b.start ?? '',
      end: b.end ?? '',
    }));
  }

  return {
    success: true,
    data: {
      timeMin,
      timeMax,
      calendars: busyTimes,
    },
  };
}
