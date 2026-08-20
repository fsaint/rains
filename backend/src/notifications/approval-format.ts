/**
 * Rich approval-message formatters for the Telegram transport.
 *
 * Approval DMs default to a truncated `JSON.stringify` of the tool arguments,
 * which is unreadable for the tools where the arguments *are* the thing the
 * user is approving. Email and calendar write tools get dedicated renderers.
 *
 * All formatters here emit HTML parse mode: subjects, titles, and descriptions
 * routinely contain Markdown-special characters (`_`, `*`, `[`) that break
 * Telegram's legacy Markdown parser, whereas HTML only needs & < > escaped.
 */

import type { ApprovalRequest } from '@reins/shared';

export interface FormattedApproval {
  text: string;
  keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
  parseMode: 'HTML';
}

// Email-sending tools get a rich To/Cc/Subject/Body preview instead of a
// truncated JSON dump. *_send_draft tools only carry a draftId, so they are
// intentionally excluded and keep the generic branch.
export const EMAIL_TOOLS = new Set([
  'gmail_send_message',
  'gmail_create_draft',
  'outlook_mail_send_message',
  'outlook_mail_create_draft',
  'outlook_mail_reply',
]);

// Calendar write tools. Google (`calendar_*`) and Outlook (`outlook_cal_*`)
// use different argument names for the same concepts; the formatter normalizes
// both into one shape before rendering.
export const CALENDAR_TOOLS = new Set([
  'calendar_create_event',
  'calendar_update_event',
  'calendar_delete_event',
  'outlook_cal_create_event',
  'outlook_cal_update_event',
  'outlook_cal_delete_event',
  'outlook_cal_respond_to_event',
]);

/**
 * Helm Admin write tools. These act on *another agent*, identified in the
 * arguments only by id, so the generic formatter renders them as
 * `{"agentId":"V1StGXR8_Z5jdHi6B-myT"}` — and approving the destruction of an
 * agent you cannot identify is not consent.
 *
 * The id is resolved to a name by the caller, which can reach the database;
 * this module stays pure. A hallucinated id therefore shows up as the wrong
 * agent's *name* on the owner's phone, which is the failure this most needs to
 * catch.
 */
export const ADMIN_TOOLS = new Set([
  'helm_admin_create_agent',
  'helm_admin_destroy_agent',
  'helm_admin_rename_agent',
  'helm_admin_set_description',
  'helm_admin_set_status',
  'helm_admin_enable_service',
  'helm_admin_disable_service',
  'helm_admin_set_permission_level',
  'helm_admin_set_tool_permission',
  'helm_admin_reset_tool_permission',
]);

/** What the caller resolved about the agent an admin tool is acting on. */
export interface AdminTargetSummary {
  id: string;
  name: string;
  status?: string | null;
  runtime?: string | null;
  deploymentStatus?: string | null;
  /** Service types with their permission level, e.g. `gmail (full)`. */
  services?: string[];
}

// Telegram body preview cap. The Telegram message hard limit is 4096 chars;
// leave generous headroom for the headers, blockquote markup, and buttons.
const BODY_PREVIEW_LIMIT = 3000;

// Long invite lists get elided rather than blowing the message budget.
const ATTENDEE_PREVIEW_LIMIT = 10;

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Describe how many messages a batch tool call would affect, e.g. "412 messages".
 *
 * The generic approval message truncates its JSON argument dump at 200
 * characters, which lands mid-array for a batch of message ids — so without
 * this the human is asked to approve "modify labels" with no idea whether that
 * means one message or a thousand. Returns null when the call is not a batch,
 * so the caller can omit the line entirely.
 */
export function formatBatchScope(args: Record<string, unknown> | undefined): string | null {
  const ids = args?.messageIds;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  return `${ids.length} message${ids.length === 1 ? '' : 's'}`;
}

/**
 * Escape Telegram legacy-Markdown specials.
 *
 * Required wherever user-authored text lands in a Markdown-parsed message —
 * an unbalanced `_` or `*` makes Telegram reject the whole send/edit, so the
 * message silently fails to update. The resolved-message renderer still uses
 * Markdown, and correction feedback is free text typed by a human.
 */
export function escapeMarkdown(value: string): string {
  return value.replace(/([_*`[\]])/g, '\\$1');
}

/** Best-effort HTML → plain text for previewing content whose only body is HTML. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Normalize a recipient/attendee field that may be a string[] or a single string. */
export function joinRecipients(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
  if (typeof value === 'string') return value;
  return '';
}

export function approveDenyKeyboard(approvalId: string) {
  return [
    [
      { text: '✅ Approve', callback_data: `ap:${approvalId}:approve` },
      { text: '❌ Deny', callback_data: `ap:${approvalId}:deny` },
    ],
  ];
}

/**
 * Add the correction affordance to any revisable tool-call approval: a third
 * button that sends the request back to the agent with free-text feedback,
 * plus a header line when the user is looking at a redo.
 *
 * Applied centrally so every revisable branch — email, calendar, generic —
 * behaves identically, and so reauth/telegram_group (which are not tool calls
 * the agent can revise) simply never route through it.
 *
 * The button is dropped once the revision cap is reached, leaving the human
 * with approve or deny. Text is deliberately markup-free so it renders the same
 * under HTML and Markdown parse modes.
 *
 * `ap:` + a 21-char nanoid + `:changes` is 32 bytes, well inside Telegram's
 * 64-byte callback_data limit.
 */
export function withCorrectionAffordance<T extends { text: string; keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> }>(
  approval: ApprovalRequest,
  formatted: T,
  maxRevisions: number
): T {
  const canRevise = approval.revision < maxRevisions;

  return {
    ...formatted,
    text: approval.revision > 0
      ? `✏️ Revision ${approval.revision} of ${maxRevisions}\n${formatted.text}`
      : formatted.text,
    keyboard: canRevise
      ? [...formatted.keyboard, [{ text: '✏️ Request changes', callback_data: `ap:${approval.id}:changes` }]]
      : formatted.keyboard,
  };
}

function expiresLine(approval: ApprovalRequest): string {
  const expiresIn = Math.round((approval.expiresAt.getTime() - Date.now()) / 60000);
  return `Expires in ~${expiresIn} min`;
}

function truncateBody(raw: string): string {
  return raw.length > BODY_PREVIEW_LIMIT
    ? `${escapeHtml(raw.slice(0, BODY_PREVIEW_LIMIT))}\n…(truncated)`
    : escapeHtml(raw);
}

/** At most this many attachments are listed individually before eliding. */
const ATTACHMENT_PREVIEW_LIMIT = 10;

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ATTACHMENT_SOURCE_LABELS: Record<string, string> = {
  gmail: 'forwarded from an email',
  drive: 'from Google Drive',
  url: 'downloaded from a link',
  upload: 'uploaded by the agent',
  text: 'written by the agent',
  base64: 'inline data',
};

/**
 * Render the attachments of an email approval as `📎 name · size · origin`.
 *
 * A user approving an email must be able to see what is being attached — this
 * is the control that makes it safe not to maintain a MIME-type allowlist in
 * the Gmail server.
 *
 * Tolerates three shapes, because it reads whatever was persisted to
 * approvals.arguments_json: the current union, the legacy
 * {filename, mimeType, data} shape, and args already passed through
 * redactToolArgs (which replaces bulk payloads with a `_bytes` count).
 */
export function summarizeAttachments(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const lines = raw.slice(0, ATTACHMENT_PREVIEW_LIMIT).map((entry, index) => {
    const item = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;

    const source =
      typeof item.source === 'string'
        ? item.source
        : typeof item.data === 'string'
        ? 'base64'
        : typeof item.content === 'string'
        ? 'text'
        : typeof item.attachmentId === 'string'
        ? 'gmail'
        : 'unknown';

    const name =
      typeof item.filename === 'string' && item.filename.trim() !== ''
        ? item.filename
        : source === 'gmail'
        ? '(original filename)'
        : `attachment-${index + 1}`;

    // `_bytes` is what redactToolArgs leaves behind in place of the payload.
    const bytes =
      typeof item._bytes === 'number'
        ? item._bytes
        : typeof item.content === 'string'
        ? Buffer.byteLength(item.content, 'utf-8')
        : typeof item.data === 'string'
        ? Math.floor((item.data.length * 3) / 4)
        : undefined;

    const size = bytes !== undefined ? ` · ${formatByteSize(bytes)}` : '';
    const origin = ATTACHMENT_SOURCE_LABELS[source]
      ? ` · ${ATTACHMENT_SOURCE_LABELS[source]}`
      : '';

    return `📎 ${escapeHtml(name)}${size}${origin}`;
  });

  if (raw.length > ATTACHMENT_PREVIEW_LIMIT) {
    lines.push(`📎 …and ${raw.length - ATTACHMENT_PREVIEW_LIMIT} more`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * Rich Telegram preview for email approval requests (gmail_* / outlook_mail_*).
 * Exported for unit testing without a live bot.
 */
export function formatEmailApprovalMessage(approval: ApprovalRequest): FormattedApproval {
  const args = approval.arguments as {
    account?: string;
    to?: unknown;
    cc?: unknown;
    bcc?: unknown;
    subject?: string;
    body?: string;
    htmlBody?: string;
    threadId?: string;
    replyTo?: string;
    messageId?: string;
    attachments?: unknown;
  };

  const isReply =
    approval.tool === 'outlook_mail_reply' ||
    Boolean(args.threadId) ||
    Boolean(args.replyTo);

  let heading: string;
  if (approval.tool === 'gmail_create_draft' || approval.tool === 'outlook_mail_create_draft') {
    heading = '📧 <b>Save draft</b>';
  } else if (isReply) {
    heading = '📧 <b>Reply to email</b>';
  } else {
    heading = '📧 <b>Send email</b>';
  }

  const to = joinRecipients(args.to);
  const cc = joinRecipients(args.cc);
  const bcc = joinRecipients(args.bcc);

  // Prefer plain-text body; fall back to stripping the HTML that would be sent.
  const bodyText = typeof args.body === 'string' && args.body.length > 0
    ? args.body
    : typeof args.htmlBody === 'string'
    ? htmlToText(args.htmlBody)
    : '';

  const lines = [
    heading,
    args.account ? `<b>From account:</b> ${escapeHtml(args.account)}` : null,
    to ? `<b>To:</b> ${escapeHtml(to)}` : null,
    cc ? `<b>Cc:</b> ${escapeHtml(cc)}` : null,
    bcc ? `<b>Bcc:</b> ${escapeHtml(bcc)}` : null,
    args.subject ? `<b>Subject:</b> ${escapeHtml(args.subject)}` : null,
    isReply ? `↩︎ <i>Reply</i>` : null,
    `<b>Agent:</b> <code>${escapeHtml(approval.agentId)}</code>`,
    // Before the body: the body preview is length-capped, and what is being
    // attached must never be the thing that gets truncated away.
    ...(summarizeAttachments(args.attachments) ?? []),
    bodyText ? `<blockquote>${truncateBody(bodyText)}</blockquote>` : null,
    ``,
    expiresLine(approval),
  ].filter(Boolean);

  return {
    text: lines.join('\n'),
    keyboard: approveDenyKeyboard(approval.id),
    parseMode: 'HTML',
  };
}

// ---------------------------------------------------------------------------
// Date/time rendering
// ---------------------------------------------------------------------------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

interface IsoParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour?: number;
  minute?: number;
  /** Trailing zone designator as written: "Z", "+05:30", "-0700", or undefined. */
  offset?: string;
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Parse an ISO 8601 string into its literal components.
 *
 * Deliberately avoids `new Date()`: that would resolve the instant and then
 * re-render it in the *server's* timezone, so an event the agent specified as
 * 10:00 in Los Angeles would be shown to the approver as 18:00. We want the
 * wall-clock time exactly as written, so that what you approve is what gets
 * created. Returns null for anything unrecognized, and callers fall back to
 * echoing the raw string.
 */
export function parseIsoParts(value: string): IsoParts | null {
  const m = ISO_RE.exec(value.trim());
  if (!m) return null;

  const [, y, mo, d, hh, mm, , zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const parts: IsoParts = { year, month, day };
  if (hh !== undefined && mm !== undefined) {
    const hour = Number(hh);
    const minute = Number(mm);
    if (hour > 23 || minute > 59) return null;
    parts.hour = hour;
    parts.minute = minute;
  }
  if (zone) parts.offset = zone.toUpperCase() === 'Z' ? 'Z' : zone;
  return parts;
}

function weekdayOf(p: IsoParts): string {
  // Date.UTC is safe here — no local-timezone shift is applied to the result.
  return WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()];
}

function formatDate(p: IsoParts, opts: { weekday?: boolean; year?: boolean } = {}): string {
  const { weekday = true, year = true } = opts;
  const head = weekday ? `${weekdayOf(p)}, ` : '';
  const tail = year ? `, ${p.year}` : '';
  return `${head}${MONTHS[p.month - 1]} ${p.day}${tail}`;
}

function formatTime(p: IsoParts): string {
  if (p.hour === undefined || p.minute === undefined) return '';
  const suffix = p.hour < 12 ? 'AM' : 'PM';
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${String(p.minute).padStart(2, '0')} ${suffix}`;
}

/** Human label for the zone an event was specified in, or '' when unknown. */
function zoneLabel(p: IsoParts | null, timeZone?: string): string {
  if (timeZone) return timeZone;
  if (!p?.offset) return '';
  if (p.offset === 'Z') return 'UTC';
  const normalized = p.offset.length === 5 // "+0530" → "+05:30"
    ? `${p.offset.slice(0, 3)}:${p.offset.slice(3)}`
    : p.offset;
  return `UTC${normalized}`;
}

function sameDay(a: IsoParts, b: IsoParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/** Minutes between two same-zone timestamps, or null when not computable. */
function durationMinutes(a: IsoParts, b: IsoParts): number | null {
  if (a.hour === undefined || b.hour === undefined) return null;
  // Offsets must match, otherwise the wall-clock difference is not the duration.
  if ((a.offset ?? '') !== (b.offset ?? '')) return null;
  const start = Date.UTC(a.year, a.month - 1, a.day, a.hour, a.minute ?? 0);
  const end = Date.UTC(b.year, b.month - 1, b.day, b.hour, b.minute ?? 0);
  const mins = (end - start) / 60000;
  return mins > 0 ? mins : null;
}

function formatDuration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** Step a date back one day, for rendering exclusive all-day end dates. */
function previousDay(p: IsoParts): IsoParts {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  d.setUTCDate(d.getUTCDate() - 1);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Render the "When" line for an event.
 *
 * `allDay` end dates are treated as exclusive — that is how both the Google
 * Calendar API and Microsoft Graph interpret them, and the Google handler
 * passes `endDate` through verbatim — so we step back one day to show the
 * inclusive last day the user actually sees on their calendar.
 */
export function formatEventWhen(input: {
  start?: string;
  end?: string;
  allDay?: boolean;
  timeZone?: string;
}): string | null {
  const { start, end, allDay, timeZone } = input;
  if (!start && !end) return null;

  const ps = start ? parseIsoParts(start) : null;
  const pe = end ? parseIsoParts(end) : null;

  // Unparseable input: echo verbatim rather than guessing or throwing.
  if ((start && !ps) || (end && !pe)) {
    return [start, end].filter(Boolean).join(' → ');
  }

  const isAllDay = allDay === true || (ps !== null && ps.hour === undefined);

  if (isAllDay) {
    if (!ps) return end ?? null;
    const lastDay = pe && !sameDay(ps, pe) ? previousDay(pe) : null;
    if (!lastDay || sameDay(ps, lastDay)) {
      return `${formatDate(ps)} (all day)`;
    }
    const sameYear = ps.year === lastDay.year;
    return `${formatDate(ps, { weekday: false, year: !sameYear })} – ${formatDate(lastDay, {
      weekday: false,
    })} (all day)`;
  }

  if (!ps) return end ?? null;

  const zone = zoneLabel(ps, timeZone);
  const zoneSuffix = zone ? ` (${zone})` : '';

  if (!pe) {
    return `${formatDate(ps)} · ${formatTime(ps)}${zoneSuffix}`;
  }

  if (sameDay(ps, pe)) {
    const mins = durationMinutes(ps, pe);
    const dur = mins ? ` · ${formatDuration(mins)}` : '';
    return `${formatDate(ps)} · ${formatTime(ps)} – ${formatTime(pe)}${zoneSuffix}${dur}`;
  }

  return `${formatDate(ps, { weekday: false })} ${formatTime(ps)} → ${formatDate(pe, {
    weekday: false,
  })} ${formatTime(pe)}${zoneSuffix}`;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

const RESPONSE_LABELS: Record<string, string> = {
  accept: '✅ Accept',
  tentativelyAccept: '❔ Tentative',
  decline: '❌ Decline',
};

const SEND_UPDATES_LABELS: Record<string, string> = {
  all: 'all guests',
  externalOnly: 'external guests only',
  none: 'nobody',
};

/** Normalize Google and Outlook argument shapes into one preview model. */
function normalizeCalendarArgs(approval: ApprovalRequest) {
  const a = approval.arguments as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;

  const description =
    str(a.description) ??
    str(a.body) ??
    (typeof a.htmlBody === 'string' ? htmlToText(a.htmlBody) : undefined);

  // Google uses startTime/endTime (offset-bearing) or startDate/endDate for
  // all-day; Outlook uses startDateTime/endDateTime plus a separate timeZone.
  const allDay = a.allDay === true || a.isAllDay === true;

  return {
    calendarId: str(a.calendarId),
    eventId: str(a.eventId),
    title: str(a.summary) ?? str(a.subject),
    start: str(a.startTime) ?? str(a.startDateTime) ?? str(a.startDate),
    end: str(a.endTime) ?? str(a.endDateTime) ?? str(a.endDate),
    allDay: allDay || (a.startDate !== undefined && a.startTime === undefined),
    timeZone: str(a.timeZone),
    location: str(a.location),
    attendees: Array.isArray(a.attendees) ? a.attendees.map(String) : [],
    description,
    online: a.conferenceData === true ? 'Google Meet' : a.isOnlineMeeting === true ? 'Teams meeting' : undefined,
    recurrence: Array.isArray(a.recurrence)
      ? a.recurrence.map(String).join('; ')
      : a.recurrence && typeof a.recurrence === 'object'
      ? 'Recurring'
      : undefined,
    sendUpdates: str(a.sendUpdates),
    response: str(a.response),
    comment: str(a.comment),
  };
}

function attendeesLine(attendees: string[]): string | null {
  if (attendees.length === 0) return null;
  const shown = attendees.slice(0, ATTENDEE_PREVIEW_LIMIT);
  const extra = attendees.length - shown.length;
  const list = escapeHtml(shown.join(', ')) + (extra > 0 ? ` +${extra} more` : '');
  return `<b>Guests:</b> ${list} (${attendees.length})`;
}

/**
 * Rich Telegram preview for calendar write approvals
 * (calendar_* / outlook_cal_*). Exported for unit testing without a live bot.
 */
export function formatCalendarApprovalMessage(approval: ApprovalRequest): FormattedApproval {
  const e = normalizeCalendarArgs(approval);
  const isDelete = approval.tool.endsWith('_delete_event');
  const isUpdate = approval.tool.endsWith('_update_event');
  const isRespond = approval.tool === 'outlook_cal_respond_to_event';

  let heading: string;
  if (isDelete) heading = '🗑 <b>Delete event</b>';
  else if (isUpdate) heading = '✏️ <b>Update event</b>';
  else if (isRespond) heading = '📩 <b>Respond to invite</b>';
  else heading = '📅 <b>New event</b>';

  const when = formatEventWhen({
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    timeZone: e.timeZone,
  });

  const where = [e.location, e.online].filter(Boolean).join(' · ');

  const lines = [
    heading,
    isRespond && e.response
      ? `<b>Response:</b> ${RESPONSE_LABELS[e.response] ?? escapeHtml(e.response)}`
      : null,
    e.calendarId && e.calendarId !== 'primary'
      ? `<b>Calendar:</b> ${escapeHtml(e.calendarId)}`
      : null,
    e.title ? `<b>Title:</b> ${escapeHtml(e.title)}` : null,
    when ? `<b>When:</b> ${escapeHtml(when)}` : null,
    where ? `<b>Where:</b> ${escapeHtml(where)}` : null,
    attendeesLine(e.attendees),
    e.recurrence ? `🔁 <b>Repeats:</b> ${escapeHtml(e.recurrence)}` : null,
    e.sendUpdates
      ? `<b>Notify:</b> ${escapeHtml(SEND_UPDATES_LABELS[e.sendUpdates] ?? e.sendUpdates)}`
      : null,
    e.eventId ? `<b>Event:</b> <code>${escapeHtml(e.eventId)}</code>` : null,
    `<b>Agent:</b> <code>${escapeHtml(approval.agentId)}</code>`,
    e.description || e.comment
      ? `<blockquote>${truncateBody((e.description ?? e.comment) as string)}</blockquote>`
      : null,
    isUpdate ? `\n<i>Fields not listed are unchanged.</i>` : null,
    isDelete ? `\n<i>This cannot be undone.</i>` : null,
    ``,
    expiresLine(approval),
  ].filter(Boolean);

  return {
    text: lines.join('\n'),
    keyboard: approveDenyKeyboard(approval.id),
    parseMode: 'HTML',
  };
}

/**
 * Render a Helm Admin write for approval, naming the agent it acts on.
 *
 * `target` is null when the tool creates an agent (there is nothing to look up
 * yet) or when the id did not resolve — the latter is worth showing plainly
 * rather than hiding, because an id that matches no agent of yours is itself
 * the most useful thing the message can tell you.
 */
export function formatAdminApprovalMessage(
  approval: ApprovalRequest,
  target: AdminTargetSummary | null
): FormattedApproval {
  const args = (approval.arguments ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

  const targetName = target
    ? `“${escapeHtml(target.name)}”`
    : str(args.agentId)
      ? `<i>unknown agent</i> <code>${escapeHtml(str(args.agentId) as string)}</code>`
      : '';

  const isDestroy = approval.tool === 'helm_admin_destroy_agent';
  const isCreate = approval.tool === 'helm_admin_create_agent';

  const headings: Record<string, string> = {
    helm_admin_create_agent: '✨ <b>Create agent</b>',
    helm_admin_destroy_agent: '⚠️ <b>Destroy agent</b>',
    helm_admin_rename_agent: '✏️ <b>Rename agent</b>',
    helm_admin_set_description: '✏️ <b>Change description</b>',
    helm_admin_set_status: '⏸ <b>Change status</b>',
    helm_admin_enable_service: '➕ <b>Give an agent access</b>',
    helm_admin_disable_service: '➖ <b>Remove an agent’s access</b>',
    helm_admin_set_permission_level: '🔑 <b>Change access level</b>',
    helm_admin_set_tool_permission: '🔧 <b>Change one tool</b>',
    helm_admin_reset_tool_permission: '↩️ <b>Reset a tool override</b>',
  };

  // The one line that says what is actually being decided.
  let action: string | null = null;
  switch (approval.tool) {
    case 'helm_admin_create_agent':
      action = `<b>Name:</b> ${escapeHtml(str(args.name) ?? '(unnamed)')}`;
      break;
    case 'helm_admin_rename_agent':
      action = `<b>New name:</b> ${escapeHtml(str(args.name) ?? '')}`;
      break;
    case 'helm_admin_set_description':
      action = str(args.description)
        ? `<b>New description:</b> ${escapeHtml(str(args.description) as string)}`
        : '<b>Description:</b> <i>cleared</i>';
      break;
    case 'helm_admin_set_status':
      action = `<b>New status:</b> ${escapeHtml(str(args.status) ?? '')}`;
      break;
    case 'helm_admin_enable_service':
    case 'helm_admin_disable_service':
      action = `<b>Service:</b> ${escapeHtml(str(args.serviceType) ?? '')}`;
      break;
    case 'helm_admin_set_permission_level':
      action = `<b>Service:</b> ${escapeHtml(str(args.serviceType) ?? '')} → ${escapeHtml(str(args.level) ?? '')}`;
      break;
    case 'helm_admin_set_tool_permission':
      action = `<b>Tool:</b> ${escapeHtml(str(args.toolName) ?? '')} → ${escapeHtml(str(args.permission) ?? '')}`;
      break;
    case 'helm_admin_reset_tool_permission':
      action = `<b>Tool:</b> ${escapeHtml(str(args.toolName) ?? '')} → service default`;
      break;
  }

  const lines = [
    headings[approval.tool] ?? '<b>Agent administration</b>',
    isCreate ? null : targetName ? `<b>Agent:</b> ${targetName}` : null,
    action,
    // On a destroy, what the agent currently holds is the clearest signal of
    // whether this is the right agent — and of what stops working afterwards.
    isDestroy && target?.services?.length
      ? `<b>Has access to:</b> ${escapeHtml(target.services.join(', '))}`
      : null,
    isDestroy && target?.runtime
      ? `<b>Runtime:</b> ${escapeHtml(target.runtime)}${target.deploymentStatus ? `, ${escapeHtml(target.deploymentStatus)}` : ''}`
      : null,
    isCreate
      ? `\n<i>Its endpoint will require a token, so knowing its id is not enough to use it.</i>`
      : null,
    isDestroy
      ? `\n<i>This cannot be undone. The runtime machine and all access are removed. Notes it saved to your memory are kept.</i>`
      : null,
    `\n<b>Requested by:</b> <code>${escapeHtml(approval.agentId)}</code>`,
    ``,
    expiresLine(approval),
  ].filter(Boolean);

  return {
    text: lines.join('\n'),
    keyboard: approveDenyKeyboard(approval.id),
    parseMode: 'HTML',
  };
}
