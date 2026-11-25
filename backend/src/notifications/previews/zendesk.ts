/**
 * Previews for Zendesk writes. A ticket is shown by subject and requester, and
 * a comment says whether the customer will see it.
 */
import type { ApprovalRequest } from '@reins/shared';
import { registerPreview, type ApprovalPreview, type PreviewRow } from '../approval-preview.js';
import { argsOf, connectionFor, fetchJson, humanize, idOf, str, strList } from './shared.js';

interface Ticket {
  subject?: string;
  status?: string;
  priority?: string | null;
  requester_id?: number;
  assignee_id?: number | null;
  tags?: string[];
}

interface TicketResponse {
  ticket?: Ticket;
  users?: Array<{ id: number; name?: string; email?: string }>;
}

async function getTicket(approval: ApprovalRequest, ticketId: string): Promise<TicketResponse | null> {
  const connection = await connectionFor(approval, 'zendesk');
  const subdomain = str(connection?.data.subdomain);
  const email = str(connection?.data.email);
  // The subdomain becomes part of the host name, so it must be a bare label.
  if (!connection || !subdomain || !email || !/^[a-z0-9-]+$/i.test(subdomain)) return null;
  const basic = Buffer.from(`${email}/token:${connection.token}`).toString('base64');
  return fetchJson<TicketResponse>(
    `https://${subdomain}.zendesk.com/api/v2/tickets/${encodeURIComponent(ticketId)}.json?include=users`,
    { headers: { Authorization: `Basic ${basic}` } }
  );
}

async function buildZendeskPreview(approval: ApprovalRequest): Promise<ApprovalPreview | null> {
  const args = argsOf(approval);
  const tags = Array.isArray(args.tags) ? strList(args.tags).join(', ') || '(none)' : undefined;

  if (approval.tool === 'zendesk_create_ticket') {
    const rows: PreviewRow[] = [{ label: 'Subject', value: str(args.subject) ?? '(none)' }];
    const requester = [str(args.requester_name), str(args.requester_email)].filter(Boolean).join(' · ');
    rows.push({ label: 'Requester', value: requester || 'You' });
    if (str(args.assignee_email)) rows.push({ label: 'Assignee', value: str(args.assignee_email)! });
    if (str(args.priority)) rows.push({ label: 'Priority', value: humanize(str(args.priority)!) });
    if (str(args.type)) rows.push({ label: 'Type', value: humanize(str(args.type)!) });
    if (tags) rows.push({ label: 'Tags', value: tags });
    return {
      icon: '🎫',
      heading: 'Create Zendesk ticket',
      note: str(args.requester_email) ? 'The requester is emailed the ticket.' : undefined,
      rows,
      body: str(args.body) ? { label: 'First message', text: str(args.body)! } : undefined,
    };
  }

  const ticketId = idOf(args.ticket_id);
  if (!ticketId) return null;
  const found = await getTicket(approval, ticketId);
  const ticket = found?.ticket;
  const user = (id: number | null | undefined) => {
    const match = found?.users?.find((u) => u.id === id);
    return match ? [match.name, match.email].filter(Boolean).join(' · ') : undefined;
  };

  const rows: PreviewRow[] = [
    { label: 'Ticket', value: ticket?.subject ? `#${ticketId} ${ticket.subject}` : `#${ticketId}` },
  ];
  const requester = user(ticket?.requester_id);
  if (requester) rows.push({ label: 'Requester', value: requester });

  const change = (label: string, value: string | undefined, was: string | undefined) => {
    if (value === undefined) return;
    if (!ticket) rows.push({ label, value });
    else if (value !== was) rows.push({ label, value, was: was ?? '' });
  };
  change('Subject', str(args.subject), ticket?.subject);
  change('Status', str(args.status) && humanize(str(args.status)!), ticket?.status && humanize(ticket.status));
  change(
    'Priority',
    str(args.priority) && humanize(str(args.priority)!),
    ticket ? (ticket.priority ? humanize(ticket.priority) : '') : undefined
  );
  change('Assignee', str(args.assignee_email), ticket ? user(ticket.assignee_id) ?? '' : undefined);
  change('Tags', tags, ticket ? (ticket.tags ?? []).join(', ') || '(none)' : undefined);

  const comment = str(args.comment);
  const isPublic = args.comment_public !== false;

  return {
    icon: '🎫',
    heading: `Update ticket #${ticketId}`,
    note: comment && isPublic ? 'The reply is public: the requester will receive it.' : undefined,
    destructive: Boolean(comment && isPublic) || undefined,
    rows,
    warning: ticket ? undefined : 'Could not load this ticket. Approve only if you recognise its number.',
    body: comment ? { label: isPublic ? 'Public reply' : 'Internal note', text: comment } : undefined,
  };
}

registerPreview(['zendesk_create_ticket', 'zendesk_update_ticket'], buildZendeskPreview);
