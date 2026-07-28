/**
 * Tests for the rich email and calendar previews in Telegram approval messages.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock the DB so importing telegram.ts (which pulls in config/db at module load)
// does not require a live database connection.
vi.mock('../db/index.js', () => ({
  client: { execute: vi.fn().mockResolvedValue({ rows: [] }) },
}));

import { formatCalendarApprovalMessage, formatEmailApprovalMessage } from './telegram.js';
import type { ApprovalRequest } from '@reins/shared';

function makeApproval(overrides: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: 'appr-1',
    agentId: 'agent-abc',
    tool: 'gmail_send_message',
    arguments: {},
    status: 'pending',
    requestedAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    ...overrides,
  };
}

describe('formatEmailApprovalMessage', () => {
  it('renders To / Cc / Subject / Body from array recipients', () => {
    const approval = makeApproval({
      tool: 'gmail_send_message',
      arguments: {
        to: ['a@x.com', 'b@y.com'],
        cc: ['c@z.com'],
        subject: 'Quarterly update',
        body: 'Hello team,\nHere is the update.',
        account: 'me@gmail.com',
      },
    });

    const { text, keyboard, parseMode } = formatEmailApprovalMessage(approval);

    expect(parseMode).toBe('HTML');
    expect(text).toContain('📧 <b>Send email</b>');
    expect(text).toContain('<b>From account:</b> me@gmail.com');
    expect(text).toContain('<b>To:</b> a@x.com, b@y.com');
    expect(text).toContain('<b>Cc:</b> c@z.com');
    expect(text).toContain('<b>Subject:</b> Quarterly update');
    expect(text).toContain('Here is the update.');
    // Approve/Deny buttons preserved with the same callback format.
    expect(keyboard[0][0].callback_data).toBe('ap:appr-1:approve');
    expect(keyboard[0][1].callback_data).toBe('ap:appr-1:deny');
  });

  it('HTML-escapes email content and does not choke on Markdown-special chars', () => {
    const approval = makeApproval({
      arguments: {
        to: ['a@x.com'],
        subject: 'Hi_there *now* [link]',
        body: 'Line1\nLine2 with `backticks` and <b>bold</b> & <script>',
      },
    });

    const { text } = formatEmailApprovalMessage(approval);

    // Markdown specials survive verbatim (HTML mode ignores them).
    expect(text).toContain('Hi_there *now* [link]');
    // Angle brackets / ampersands from the body are escaped, not rendered as tags.
    expect(text).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(text).toContain('&amp; &lt;script&gt;');
    // The only literal <b> tags come from our own markup, never from user content.
    expect(text).not.toContain('<b>bold</b>');
  });

  it('labels draft tools and reply threads', () => {
    const draft = formatEmailApprovalMessage(
      makeApproval({ tool: 'gmail_create_draft', arguments: { to: ['a@x.com'], subject: 's' } })
    );
    expect(draft.text).toContain('📧 <b>Save draft</b>');

    const reply = formatEmailApprovalMessage(
      makeApproval({ arguments: { to: ['a@x.com'], subject: 're', body: 'ok', threadId: 't1' } })
    );
    expect(reply.text).toContain('↩︎ <i>Reply</i>');
  });

  it('falls back to stripped HTML body when only htmlBody is present', () => {
    const approval = makeApproval({
      arguments: {
        to: ['a@x.com'],
        subject: 's',
        htmlBody: '<p>Hello</p><br><b>World</b>',
      },
    });
    const { text } = formatEmailApprovalMessage(approval);
    expect(text).toContain('Hello');
    expect(text).toContain('World');
    // Tags were stripped, so no raw markup from htmlBody leaks through.
    expect(text).not.toContain('<p>');
  });

  it('truncates very long bodies within the Telegram limit', () => {
    const approval = makeApproval({
      arguments: { to: ['a@x.com'], subject: 's', body: 'x'.repeat(5000) },
    });
    const { text } = formatEmailApprovalMessage(approval);
    expect(text).toContain('…(truncated)');
    expect(text.length).toBeLessThan(4096);
  });
});

describe('formatCalendarApprovalMessage', () => {
  it('renders a Google create with the wall-clock time as written', () => {
    const approval = makeApproval({
      tool: 'calendar_create_event',
      arguments: {
        summary: 'Design review',
        startTime: '2026-08-05T10:00:00-07:00',
        endTime: '2026-08-05T11:00:00-07:00',
        location: 'Conf room B',
        conferenceData: true,
        attendees: ['a@x.com', 'b@y.com'],
        description: 'Walk through the new approval UI',
      },
    });

    const { text, keyboard, parseMode } = formatCalendarApprovalMessage(approval);

    expect(parseMode).toBe('HTML');
    expect(text).toContain('📅 <b>New event</b>');
    expect(text).toContain('<b>Title:</b> Design review');
    // Rendered in the event's own zone — NOT shifted into the server timezone.
    expect(text).toContain('<b>When:</b> Wed, Aug 5, 2026 · 10:00 AM – 11:00 AM (UTC-07:00) · 1h');
    expect(text).toContain('<b>Where:</b> Conf room B · Google Meet');
    expect(text).toContain('<b>Guests:</b> a@x.com, b@y.com (2)');
    expect(text).toContain('Walk through the new approval UI');
    // Same callback contract as every other approval, so the webhook is unchanged.
    expect(keyboard[0][0].callback_data).toBe('ap:appr-1:approve');
    expect(keyboard[0][1].callback_data).toBe('ap:appr-1:deny');
  });

  it('uses the separate timeZone field for Outlook naive timestamps', () => {
    const approval = makeApproval({
      tool: 'outlook_cal_create_event',
      arguments: {
        subject: 'Standup',
        startDateTime: '2026-08-05T09:00:00',
        endDateTime: '2026-08-05T09:30:00',
        timeZone: 'America/New_York',
        isOnlineMeeting: true,
        body: 'Daily sync',
      },
    });

    const { text } = formatCalendarApprovalMessage(approval);
    expect(text).toContain('<b>Title:</b> Standup');
    expect(text).toContain('9:00 AM – 9:30 AM (America/New_York) · 30m');
    expect(text).toContain('<b>Where:</b> Teams meeting');
  });

  it('renders all-day events, treating the end date as exclusive', () => {
    const single = formatCalendarApprovalMessage(
      makeApproval({
        tool: 'calendar_create_event',
        arguments: { summary: 'Holiday', allDay: true, startDate: '2026-08-05', endDate: '2026-08-06' },
      })
    );
    // End is exclusive, so a 05→06 range is a single day on the calendar.
    expect(single.text).toContain('<b>When:</b> Wed, Aug 5, 2026 (all day)');

    const range = formatCalendarApprovalMessage(
      makeApproval({
        tool: 'calendar_create_event',
        arguments: { summary: 'Offsite', allDay: true, startDate: '2026-08-05', endDate: '2026-08-08' },
      })
    );
    expect(range.text).toContain('<b>When:</b> Aug 5 – Aug 7, 2026 (all day)');
  });

  it('renders multi-day timed events with an arrow', () => {
    const { text } = formatCalendarApprovalMessage(
      makeApproval({
        tool: 'calendar_create_event',
        arguments: {
          summary: 'Conference',
          startTime: '2026-08-05T10:00:00-07:00',
          endTime: '2026-08-07T14:00:00-07:00',
        },
      })
    );
    expect(text).toContain('Aug 5, 2026 10:00 AM → Aug 7, 2026 2:00 PM (UTC-07:00)');
  });

  it('labels update and delete, and shows only the fields present', () => {
    const update = formatCalendarApprovalMessage(
      makeApproval({
        tool: 'calendar_update_event',
        arguments: { eventId: 'evt-123', location: 'Room 4' },
      })
    );
    expect(update.text).toContain('✏️ <b>Update event</b>');
    expect(update.text).toContain('<b>Event:</b> <code>evt-123</code>');
    expect(update.text).toContain('<b>Where:</b> Room 4');
    expect(update.text).toContain('Fields not listed are unchanged.');
    // No title/when lines when those arguments were not supplied.
    expect(update.text).not.toContain('<b>Title:</b>');
    expect(update.text).not.toContain('<b>When:</b>');

    const del = formatCalendarApprovalMessage(
      makeApproval({
        tool: 'outlook_cal_delete_event',
        arguments: { eventId: 'evt-9' },
      })
    );
    expect(del.text).toContain('🗑 <b>Delete event</b>');
    expect(del.text).toContain('This cannot be undone.');
  });

  it('renders an invite response with its comment', () => {
    const { text } = formatCalendarApprovalMessage(
      makeApproval({
        tool: 'outlook_cal_respond_to_event',
        arguments: { eventId: 'evt-7', response: 'decline', comment: 'Conflict that morning' },
      })
    );
    expect(text).toContain('📩 <b>Respond to invite</b>');
    expect(text).toContain('<b>Response:</b> ❌ Decline');
    expect(text).toContain('Conflict that morning');
  });

  it('HTML-escapes titles and descriptions containing Markdown specials', () => {
    const { text } = formatCalendarApprovalMessage(
      makeApproval({
        tool: 'calendar_create_event',
        arguments: {
          summary: 'Review_v2 *final* [draft]',
          description: 'Notes with <b>bold</b> & <script>',
        },
      })
    );
    expect(text).toContain('Review_v2 *final* [draft]');
    expect(text).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(text).toContain('&amp; &lt;script&gt;');
    expect(text).not.toContain('<b>bold</b>');
  });

  it('falls back to the raw string when a timestamp is unparseable', () => {
    const { text } = formatCalendarApprovalMessage(
      makeApproval({
        tool: 'calendar_create_event',
        arguments: { summary: 'Odd', startTime: 'next tuesday', endTime: 'whenever' },
      })
    );
    expect(text).toContain('next tuesday → whenever');
  });

  it('elides long guest lists and truncates long descriptions', () => {
    const attendees = Array.from({ length: 14 }, (_, i) => `guest${i}@x.com`);
    const { text } = formatCalendarApprovalMessage(
      makeApproval({
        tool: 'calendar_create_event',
        arguments: { summary: 'Big', attendees, description: 'x'.repeat(5000) },
      })
    );
    expect(text).toContain('+4 more (14)');
    expect(text).toContain('…(truncated)');
    expect(text.length).toBeLessThan(4096);
  });

  it('hides the calendar line for the default primary calendar', () => {
    const primary = formatCalendarApprovalMessage(
      makeApproval({ tool: 'calendar_create_event', arguments: { summary: 's', calendarId: 'primary' } })
    );
    expect(primary.text).not.toContain('<b>Calendar:</b>');

    const other = formatCalendarApprovalMessage(
      makeApproval({ tool: 'calendar_create_event', arguments: { summary: 's', calendarId: 'team@x.com' } })
    );
    expect(other.text).toContain('<b>Calendar:</b> team@x.com');
  });
});
