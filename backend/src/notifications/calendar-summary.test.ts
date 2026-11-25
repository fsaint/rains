/**
 * The event a calendar approval acts on. Update, delete and respond carry only
 * an event id, so the event is read live from Google Calendar or Outlook.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  client: { execute: vi.fn().mockResolvedValue({ rows: [] }) },
}));
vi.mock('../credentials/vault.js', () => ({
  credentialVault: { getValidAccessToken: vi.fn().mockResolvedValue('tok') },
}));

import { client } from '../db/index.js';
import {
  buildCalendarApprovalSummary,
  calendarApprovalNeedsEvent,
  resolveCalendarEvent,
} from './calendar-summary.js';
import type { ApprovalRequest } from '@reins/shared';

function makeApproval(overrides: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: 'appr-1',
    agentId: 'agent-abc',
    tool: 'calendar_update_event',
    arguments: {},
    status: 'pending',
    requestedAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    revision: 0,
    ...overrides,
  };
}

const INSTANCE = { credential_id: 'cred-1', is_default: 1, account_email: 'me@example.com' };

/** Answer each fetch from a list, in order; the last answer repeats. */
function stubFetch(...answers: Array<{ body: unknown; status?: number }>) {
  let i = 0;
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
    const answer = answers[Math.min(i++, answers.length - 1)];
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

let serviceTypes: unknown[];

beforeEach(() => {
  serviceTypes = [];
  vi.mocked(client.execute).mockReset();
  vi.mocked(client.execute).mockImplementation(async (q: unknown) => {
    serviceTypes.push((q as { args: unknown[] }).args[1]);
    return { rows: [INSTANCE] } as never;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('calendarApprovalNeedsEvent', () => {
  it('is true for the tools that name an existing event', () => {
    for (const tool of ['calendar_update_event', 'calendar_delete_event', 'outlook_cal_respond_to_event']) {
      expect(calendarApprovalNeedsEvent(makeApproval({ tool, arguments: { eventId: 'e1' } }))).toBe(true);
    }
    expect(calendarApprovalNeedsEvent(makeApproval({ tool: 'calendar_create_event' }))).toBe(false);
    expect(calendarApprovalNeedsEvent(makeApproval({ tool: 'calendar_update_event', arguments: {} }))).toBe(false);
  });
});

describe('resolveCalendarEvent — Google', () => {
  const GOOGLE_EVENT = {
    summary: 'Weekly sync',
    start: { dateTime: '2026-11-26T10:00:00-03:00', timeZone: 'America/Santiago' },
    end: { dateTime: '2026-11-26T10:30:00-03:00', timeZone: 'America/Santiago' },
    location: 'Room 4',
    hangoutLink: 'https://meet.google.com/abc',
    organizer: { email: 'bob@example.com', displayName: 'Bob' },
    attendees: [
      { email: 'me@example.com', self: true },
      { email: 'ana@example.com' },
      { email: 'room-4@resource.calendar.google.com', resource: true },
    ],
    recurringEventId: 'series-1',
  };

  it('reads the event from the calendar the approval names', async () => {
    const fetchMock = stubFetch({ body: GOOGLE_EVENT });

    const event = await resolveCalendarEvent(
      makeApproval({ arguments: { eventId: 'evt/1', calendarId: 'team@group.calendar.google.com' } })
    );

    expect(event).toEqual({
      title: 'Weekly sync',
      start: '2026-11-26T10:00:00-03:00',
      end: '2026-11-26T10:30:00-03:00',
      allDay: false,
      location: 'Room 4',
      online: 'Google Meet',
      attendees: ['me@example.com', 'ana@example.com'],
      organizer: 'Bob <bob@example.com>',
      repeats: 'occurrence',
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/team%40group.calendar.google.com/events/evt%2F1'
    );
    expect(serviceTypes).toEqual(['calendar']);
  });

  it('reads an all-day repeating event', async () => {
    stubFetch({
      body: { summary: 'Offsite', start: { date: '2026-12-01' }, end: { date: '2026-12-03' }, recurrence: ['RRULE:FREQ=YEARLY'] },
    });

    const event = await resolveCalendarEvent(makeApproval({ arguments: { eventId: 'e1' } }));

    expect(event).toMatchObject({ start: '2026-12-01', end: '2026-12-03', allDay: true, repeats: 'series', attendees: [] });
  });

  it('is null when the event cannot be read', async () => {
    stubFetch({ body: { error: { message: 'Not Found' } }, status: 404 });
    expect(await resolveCalendarEvent(makeApproval({ arguments: { eventId: 'gone' } }))).toBeNull();
  });

  it('is null when the agent has no calendar connected', async () => {
    vi.mocked(client.execute).mockResolvedValue({ rows: [] } as never);
    const fetchMock = stubFetch({ body: GOOGLE_EVENT });

    expect(await resolveCalendarEvent(makeApproval({ arguments: { eventId: 'e1' } }))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('resolveCalendarEvent — Outlook', () => {
  const OUTLOOK_EVENT = {
    subject: 'Budget review',
    start: { dateTime: '2026-11-26T13:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-11-26T14:00:00.0000000', timeZone: 'UTC' },
    isAllDay: false,
    originalStartTimeZone: 'Pacific SA Standard Time',
    location: { displayName: 'HQ' },
    isOnlineMeeting: true,
    organizer: { emailAddress: { name: 'Bob', address: 'bob@example.com' } },
    attendees: [
      { emailAddress: { name: 'Ana', address: 'ana@example.com' }, type: 'required' },
      { emailAddress: { address: 'room@example.com' }, type: 'resource' },
    ],
    type: 'seriesMaster',
  };

  it("reads the event again in the event's own time zone", async () => {
    const fetchMock = stubFetch(
      { body: OUTLOOK_EVENT },
      {
        body: {
          ...OUTLOOK_EVENT,
          start: { dateTime: '2026-11-26T10:00:00.0000000', timeZone: 'Pacific SA Standard Time' },
          end: { dateTime: '2026-11-26T11:00:00.0000000', timeZone: 'Pacific SA Standard Time' },
        },
      }
    );

    const event = await resolveCalendarEvent(
      makeApproval({ tool: 'outlook_cal_delete_event', arguments: { eventId: 'AAMk/x=' } })
    );

    expect(event).toEqual({
      title: 'Budget review',
      start: '2026-11-26T10:00:00',
      end: '2026-11-26T11:00:00',
      allDay: false,
      timeZone: 'Pacific SA Standard Time',
      location: 'HQ',
      online: 'Teams meeting',
      attendees: ['ana@example.com'],
      organizer: 'Bob <bob@example.com>',
      repeats: 'series',
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/me/events/AAMk%2Fx%3D?');
    const second = fetchMock.mock.calls[1][1] as RequestInit;
    expect((second.headers as Record<string, string>).Prefer).toBe('outlook.timezone="Pacific SA Standard Time"');
    expect(serviceTypes[0]).toBe('outlook_calendar');
  });

  it('keeps the UTC reading when the second read fails', async () => {
    stubFetch({ body: OUTLOOK_EVENT }, { body: { error: {} }, status: 500 });

    const event = await resolveCalendarEvent(
      makeApproval({ tool: 'outlook_cal_update_event', arguments: { eventId: 'e1' } })
    );

    expect(event).toMatchObject({ start: '2026-11-26T13:00:00', timeZone: 'UTC' });
  });
});

describe('buildCalendarApprovalSummary', () => {
  it('describes an update against the event it changes', async () => {
    stubFetch({
      body: {
        summary: 'Weekly sync',
        start: { dateTime: '2026-11-26T10:00:00-03:00' },
        end: { dateTime: '2026-11-26T10:30:00-03:00' },
        attendees: [{ email: 'ana@example.com' }],
      },
    });

    const summary = await buildCalendarApprovalSummary(
      makeApproval({ arguments: { eventId: 'e1', summary: 'Sync', attendees: ['dora@example.com'] } })
    );

    expect(summary).toMatchObject({
      action: 'update',
      unresolved: false,
      title: { value: 'Sync', was: 'Weekly sync' },
      when: { value: 'Thu, Nov 26, 2026 · 10:00 AM – 10:30 AM (UTC-03:00) · 30m' },
      attendees: ['dora@example.com'],
      guestsAdded: ['dora@example.com'],
      guestsRemoved: ['ana@example.com'],
      changes: ['title', 'guests'],
    });
    expect(summary?.eventId).toBeUndefined();
  });

  it('flags an event that could not be loaded and keeps its id', async () => {
    stubFetch({ body: {}, status: 404 });

    const summary = await buildCalendarApprovalSummary(
      makeApproval({ tool: 'calendar_delete_event', arguments: { eventId: 'e1' } })
    );

    expect(summary).toMatchObject({ action: 'delete', unresolved: true, eventId: 'e1' });
  });

  it('describes a new event without a lookup', async () => {
    const fetchMock = stubFetch({ body: {} });

    const summary = await buildCalendarApprovalSummary(
      makeApproval({ tool: 'outlook_cal_create_event', arguments: { subject: 'Kickoff', attendees: ['a@x.com'] } })
    );

    expect(summary).toMatchObject({ action: 'create', unresolved: false, title: { value: 'Kickoff' }, attendees: ['a@x.com'] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is null for a tool that is not a calendar write', async () => {
    expect(await buildCalendarApprovalSummary(makeApproval({ tool: 'gmail_send_message' }))).toBeNull();
  });
});
