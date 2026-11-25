/**
 * The event a calendar approval acts on, resolved for display.
 *
 * Update, delete and respond-to-invite carry an event id and, at most, the
 * fields being changed. An id says nothing to the person approving — an
 * Outlook one is 150 characters of base64 — so the event is read live from
 * Google Calendar or Outlook and shown by title, time, place and guests.
 *
 * Every lookup failure resolves to null rather than throwing: the caller then
 * says the event could not be loaded, and the approval still goes out.
 */
import type { ApprovalRequest } from '@reins/shared';
import {
  CALENDAR_TOOLS,
  describeCalendarApproval,
  type CalendarApprovalView,
  type CalendarEventSnapshot,
} from './approval-format.js';
import { credentialFor } from './email-summary.js';

const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const LOOKUP_TIMEOUT_MS = 5000;

type Args = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** True for a calendar approval that names an event already on the calendar. */
export function calendarApprovalNeedsEvent(approval: ApprovalRequest): boolean {
  if (!CALENDAR_TOOLS.has(approval.tool) || approval.tool.endsWith('_create_event')) return false;
  return str(((approval.arguments ?? {}) as Args).eventId) !== undefined;
}

/** What a calendar approval would do, or null for a tool that is not a calendar write. */
export async function buildCalendarApprovalSummary(
  approval: ApprovalRequest
): Promise<CalendarApprovalView | null> {
  if (!CALENDAR_TOOLS.has(approval.tool)) return null;
  const existing = calendarApprovalNeedsEvent(approval) ? await resolveCalendarEvent(approval) : undefined;
  return describeCalendarApproval(approval, existing);
}

/** The event an approval names, as the calendar has it now; null when it cannot be read. */
export async function resolveCalendarEvent(approval: ApprovalRequest): Promise<CalendarEventSnapshot | null> {
  const args = (approval.arguments ?? {}) as Args;
  const eventId = str(args.eventId);
  if (!eventId) return null;
  try {
    return approval.tool.startsWith('outlook_cal_')
      ? await fetchOutlookEvent(approval.agentId, eventId, str(args.account))
      : await fetchGoogleEvent(approval.agentId, eventId, str(args.calendarId) ?? 'primary', str(args.account));
  } catch (err) {
    console.warn('[calendar-summary] could not read the event:', err);
    return null;
  }
}

function named(name: string | undefined, address: string | undefined): string | undefined {
  if (name && address && name !== address) return `${name} <${address}>`;
  return address ?? name ?? undefined;
}

async function fetchGoogleEvent(
  agentId: string,
  eventId: string,
  calendarId: string,
  account?: string
): Promise<CalendarEventSnapshot | null> {
  const credential = await credentialFor(agentId, 'calendar', account);
  if (!credential) return null;
  const res = await fetch(
    `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      headers: { Authorization: `Bearer ${credential.token}` },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    }
  );
  if (!res.ok) return null;
  const event = (await res.json()) as {
    summary?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
    location?: string;
    hangoutLink?: string;
    conferenceData?: unknown;
    organizer?: { email?: string; displayName?: string };
    attendees?: Array<{ email?: string; resource?: boolean }>;
    recurrence?: string[];
    recurringEventId?: string;
  };

  return {
    title: event.summary || undefined,
    // dateTime carries its own offset, so no zone name is needed to read it.
    start: event.start?.dateTime ?? event.start?.date,
    end: event.end?.dateTime ?? event.end?.date,
    allDay: !event.start?.dateTime && Boolean(event.start?.date),
    location: event.location || undefined,
    online: event.hangoutLink || event.conferenceData ? 'Google Meet' : undefined,
    // Rooms are booked as attendees; they are not people who get notified.
    attendees: (event.attendees ?? [])
      .filter((a) => !a.resource && a.email)
      .map((a) => a.email as string),
    organizer: named(event.organizer?.displayName, event.organizer?.email),
    repeats: event.recurringEventId ? 'occurrence' : event.recurrence?.length ? 'series' : undefined,
  };
}

type GraphEvent = {
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isAllDay?: boolean;
  originalStartTimeZone?: string;
  location?: { displayName?: string };
  isOnlineMeeting?: boolean;
  organizer?: { emailAddress?: { name?: string; address?: string } };
  attendees?: Array<{ emailAddress?: { name?: string; address?: string }; type?: string }>;
  type?: string;
};

const GRAPH_EVENT_FIELDS =
  'subject,start,end,isAllDay,originalStartTimeZone,location,isOnlineMeeting,organizer,attendees,type';

async function fetchOutlookEvent(
  agentId: string,
  eventId: string,
  account?: string
): Promise<CalendarEventSnapshot | null> {
  const credential = await credentialFor(agentId, 'outlook_calendar', account);
  if (!credential) return null;
  const read = async (timeZone?: string): Promise<GraphEvent | null> => {
    const res = await fetch(
      `${GRAPH_API}/me/events/${encodeURIComponent(eventId)}?$select=${GRAPH_EVENT_FIELDS}`,
      {
        headers: {
          Authorization: `Bearer ${credential.token}`,
          ...(timeZone ? { Prefer: `outlook.timezone="${timeZone}"` } : {}),
        },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      }
    );
    return res.ok ? ((await res.json()) as GraphEvent) : null;
  };

  let event = await read();
  if (!event) return null;

  // Graph answers in UTC unless told otherwise. A 10:00 meeting shown as 13:00
  // UTC is a preview the owner has to do arithmetic on, so it is read again in
  // the zone the event was created in. The UTC reading stands if that fails.
  const zone = event.originalStartTimeZone;
  if (zone && !event.isAllDay && zone !== (event.start?.timeZone ?? 'UTC') && /^[\w .()+:/-]+$/.test(zone)) {
    event = (await read(zone).catch(() => null)) ?? event;
  }

  // Graph writes seven fractional digits ("…T10:00:00.0000000").
  const clock = (value?: string) => value?.replace(/\.\d+$/, '');

  return {
    title: event.subject || undefined,
    start: clock(event.start?.dateTime),
    end: clock(event.end?.dateTime),
    allDay: event.isAllDay === true,
    timeZone: event.isAllDay ? undefined : event.start?.timeZone,
    location: event.location?.displayName || undefined,
    online: event.isOnlineMeeting ? 'Teams meeting' : undefined,
    attendees: (event.attendees ?? [])
      .filter((a) => a.type !== 'resource' && a.emailAddress?.address)
      .map((a) => a.emailAddress!.address as string),
    organizer: named(event.organizer?.emailAddress?.name, event.organizer?.emailAddress?.address),
    repeats:
      event.type === 'seriesMaster'
        ? 'series'
        : event.type === 'occurrence' || event.type === 'exception'
        ? 'occurrence'
        : undefined,
  };
}
