import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarDays, Repeat } from 'lucide-react';
import { approvals, type CalendarApprovalSummary as Summary } from '../api/client';

/** Tools the approvals page renders as a calendar event. Mirrors CALENDAR_TOOLS in the backend. */
export const CALENDAR_APPROVAL_TOOLS = new Set([
  'calendar_create_event',
  'calendar_update_event',
  'calendar_delete_event',
  'outlook_cal_create_event',
  'outlook_cal_update_event',
  'outlook_cal_delete_event',
  'outlook_cal_respond_to_event',
]);

const HEADINGS: Record<Summary['action'], { title: string; note?: string; destructive: boolean }> = {
  create: { title: 'New event', destructive: false },
  update: { title: 'Update event', destructive: false },
  delete: { title: 'Delete event', note: 'This cannot be undone', destructive: true },
  respond: { title: 'Respond to invite', destructive: false },
};

const RESPONSES: Record<string, string> = {
  accept: 'Accept',
  tentativelyAccept: 'Tentative',
  decline: 'Decline',
};

const NOTIFY: Record<string, string> = {
  all: 'All guests',
  externalOnly: 'External guests only',
  none: 'Nobody',
};

/** How many guests are listed before the rest are counted. */
const GUEST_LIMIT = 10;

function listed(addresses: string[]): string {
  const shown = addresses.slice(0, GUEST_LIMIT).join(', ');
  const extra = addresses.length - GUEST_LIMIT;
  return extra > 0 ? `${shown} +${extra} more` : shown;
}

function Field({ label, value, was }: { label: string; value?: string; was?: string }) {
  if (!value) return null;
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-20 shrink-0 text-gray-500">{label}</span>
      <span className="min-w-0 break-words text-gray-900">
        {was && (
          <>
            <span className="text-gray-400 line-through">{was}</span>
            <span className="mx-1 text-gray-400">→</span>
          </>
        )}
        <span className={was ? 'font-medium' : undefined}>{value}</span>
      </span>
    </div>
  );
}

export function CalendarApprovalSummary({ approvalId }: { approvalId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['approval-calendar-summary', approvalId],
    queryFn: () => approvals.calendarSummary(approvalId),
    // The lookup may call Google Calendar or Outlook; the approval itself does not change.
    staleTime: Infinity,
  });

  if (isLoading) {
    return <div className="mt-4 h-24 rounded-lg bg-gray-50 animate-pulse" aria-label="Loading event" />;
  }
  if (isError || !data) return null;

  const heading = HEADINGS[data.action];
  const resolvedUpdate = data.action === 'update' && !data.unresolved && !data.eventId;

  return (
    <div className="mt-4 rounded-lg border border-gray-200 overflow-hidden" data-testid="calendar-summary">
      <div
        className={`flex items-center gap-2 px-4 py-2 text-sm ${
          heading.destructive ? 'bg-red-50 text-alert-red' : 'bg-blue-50 text-blue-900'
        }`}
      >
        <CalendarDays className="w-4 h-4 shrink-0" />
        <span className="font-semibold">{heading.title}</span>
        {heading.note && <span className="text-xs opacity-80">— {heading.note}</span>}
      </div>

      <div className="px-4 py-3 space-y-1">
        {data.unresolved && (
          <p className="flex items-start gap-2 text-sm text-alert-red mb-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            Could not load this event. Approve only if you recognise it.
          </p>
        )}
        <Field label="Response" value={data.response ? RESPONSES[data.response] ?? data.response : undefined} />
        <Field label="Calendar" value={data.calendarId} />
        <Field label="Title" {...data.title} />
        <Field label="When" {...data.when} />
        <Field label="Where" {...data.where} />
        <Field
          label="Guests"
          value={data.attendees.length > 0 ? `${listed(data.attendees)} (${data.attendees.length})` : undefined}
        />
        <Field label="Added" value={data.guestsAdded.length > 0 ? listed(data.guestsAdded) : undefined} />
        <Field label="Removed" value={data.guestsRemoved.length > 0 ? listed(data.guestsRemoved) : undefined} />
        <Field label="Organizer" value={data.organizer} />
        <Field label="Repeats" value={data.recurrence} />
        <Field label="Notify" value={data.sendUpdates ? NOTIFY[data.sendUpdates] ?? data.sendUpdates : undefined} />
        {data.eventId && (
          <div className="flex gap-3 text-sm">
            <span className="w-20 shrink-0 text-gray-500">Event</span>
            <span className="min-w-0 break-all font-mono text-xs text-gray-600">{data.eventId}</span>
          </div>
        )}
        {data.repeatsNote && (
          <p className="flex items-start gap-2 pt-1 text-sm text-caution-amber">
            <Repeat className="w-4 h-4 mt-0.5 shrink-0" />
            {data.repeatsNote}
          </p>
        )}
        {resolvedUpdate && (
          <p className="pt-1 text-xs text-gray-500" data-testid="calendar-changes">
            {data.changes.length > 0 ? `Changes: ${data.changes.join(', ')}.` : 'Nothing shown above changes.'}
          </p>
        )}
      </div>

      {data.description && (
        <div className="border-t border-gray-100 px-4 py-3">
          {resolvedUpdate && <p className="mb-1 text-xs text-gray-500">New description</p>}
          <p className="whitespace-pre-wrap text-sm text-gray-800">{data.description}</p>
        </div>
      )}
    </div>
  );
}
