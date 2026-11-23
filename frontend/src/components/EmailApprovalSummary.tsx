import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Mail, AlertTriangle, CornerUpLeft } from 'lucide-react';
import { approvals, type EmailApprovalSummary as Summary } from '../api/client';

/** Tools the approvals page renders as an email. Mirrors isEmailApprovalTool in the backend. */
export const EMAIL_APPROVAL_TOOLS = new Set([
  'gmail_send_message',
  'gmail_create_draft',
  'gmail_update_draft',
  'gmail_send_draft',
  'outlook_mail_send_message',
  'outlook_mail_create_draft',
  'outlook_mail_reply',
  'outlook_mail_send_draft',
]);

const HEADINGS: Record<Summary['action'], { title: string; note?: string; sends: boolean }> = {
  send: { title: 'Send email', note: 'This delivers the email', sends: true },
  send_draft: { title: 'Send draft', note: 'This delivers the email', sends: true },
  reply: { title: 'Reply to email', note: 'This delivers the reply', sends: true },
  save_draft: { title: 'Save draft', note: 'Saved to Drafts, not sent', sends: false },
  update_draft: { title: 'Update draft', note: 'Replaces the saved draft, not sent', sends: false },
};

/** Long bodies are clipped with a toggle rather than stretching the card. */
const BODY_PREVIEW_CHARS = 1500;

function Field({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-16 shrink-0 text-gray-500">{label}</span>
      <span className="min-w-0 break-words text-gray-900">{value}</span>
    </div>
  );
}

export function EmailApprovalSummary({ approvalId }: { approvalId: string }) {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, isError } = useQuery({
    queryKey: ['approval-email-summary', approvalId],
    queryFn: () => approvals.emailSummary(approvalId),
    // A draft lookup may call Gmail or Outlook; the approval itself does not change.
    staleTime: Infinity,
  });

  if (isLoading) {
    return <div className="mt-4 h-24 rounded-lg bg-gray-50 animate-pulse" aria-label="Loading email" />;
  }
  if (isError || !data) return null;

  const heading = HEADINGS[data.action];
  const body = data.body ?? '';
  const clipped = body.length > BODY_PREVIEW_CHARS;

  return (
    <div className="mt-4 rounded-lg border border-gray-200 overflow-hidden" data-testid="email-summary">
      <div
        className={`flex items-center gap-2 px-4 py-2 text-sm ${
          heading.sends ? 'bg-amber-50 text-amber-900' : 'bg-blue-50 text-blue-900'
        }`}
      >
        <Mail className="w-4 h-4 shrink-0" />
        <span className="font-semibold">{heading.title}</span>
        {heading.note && <span className="text-xs opacity-80">— {heading.note}</span>}
      </div>

      <div className="px-4 py-3 space-y-1">
        {!data.resolved && (
          <p className="flex items-start gap-2 text-sm text-alert-red mb-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            Could not load this draft's content. Approve only if you recognise it.
          </p>
        )}
        {data.inReplyTo && (
          <p className="flex items-start gap-2 text-sm text-gray-600 mb-2">
            <CornerUpLeft className="w-4 h-4 mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">
              In reply to {data.inReplyTo.subject ? <>“{data.inReplyTo.subject}”</> : 'a message'}
              {data.inReplyTo.from && <> from {data.inReplyTo.from}</>}
            </span>
          </p>
        )}
        {data.recipientsUnresolved && (
          <p className="flex items-start gap-2 text-sm text-alert-red mb-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            Could not load who is on this thread. This reply also goes to{' '}
            {data.replyAll === false ? 'the sender of the original message' : 'everyone on the original message'}.
          </p>
        )}
        {data.replyAll !== undefined && (
          <p className="text-sm text-gray-600 mb-2" data-testid="reply-scope">
            {data.replyAll ? 'Reply to all' : 'Reply to sender only'}
          </p>
        )}
        <Field label="From" value={data.account} />
        <Field label="To" value={data.to} />
        <Field label="Cc" value={data.cc} />
        <Field label="Bcc" value={data.bcc} />
        <Field label="Subject" value={data.subject} />
        {data.removesAttachments && (
          <p className="text-sm text-caution-amber">Existing attachments will be removed</p>
        )}
      </div>

      {body && (
        <div className="border-t border-gray-100 px-4 py-3">
          <p className="whitespace-pre-wrap text-sm text-gray-800">
            {clipped && !expanded ? `${body.slice(0, BODY_PREVIEW_CHARS)}…` : body}
          </p>
          {clipped && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-xs text-trust-blue hover:underline"
            >
              {expanded ? 'Show less' : 'Show full message'}
            </button>
          )}
          {(data.source === 'gmail' || data.source === 'outlook') && (
            <p className="mt-2 text-xs text-gray-400">
              Read live from {data.source === 'gmail' ? 'Gmail' : 'Outlook'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
