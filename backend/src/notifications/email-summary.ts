/**
 * What an email approval would actually send, resolved for display.
 *
 * Shared by the Telegram notifier and the dashboard's approvals page. Tools
 * whose arguments carry the email (send, create/update draft, reply) are read
 * straight from the arguments. Draft-send tools carry only an id, so the draft
 * is looked up: from the approval that created it when that still describes
 * it, otherwise live from Gmail or Outlook.
 *
 * Every lookup failure resolves to null rather than throwing — the caller then
 * says the content could not be loaded, and the approval still goes out.
 */
import { client } from '../db/index.js';
import { credentialVault } from '../credentials/vault.js';
import type { ApprovalRequest } from '@reins/shared';
import {
  EMAIL_TOOLS,
  DRAFT_SEND_TOOLS,
  htmlToText,
  joinRecipients,
  type DraftSendSummary,
  type ReplySummary,
} from './approval-format.js';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const LOOKUP_TIMEOUT_MS = 5000;

/** The tools the dashboard renders as an email rather than a JSON dump. */
export function isEmailApprovalTool(tool: string): boolean {
  return EMAIL_TOOLS.has(tool) || DRAFT_SEND_TOOLS.has(tool);
}

export type EmailAction = 'send' | 'send_draft' | 'save_draft' | 'update_draft' | 'reply';

export interface EmailApprovalSummary {
  action: EmailAction;
  account?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  /** For a reply: the message being answered, when it could be looked up. */
  inReplyTo?: { subject?: string; from?: string };
  /** The draft id a send-draft approval names. */
  draftId?: string;
  /** Send-draft only: false when the draft's content could not be loaded. */
  resolved: boolean;
  /** Where a send-draft's content came from. */
  source?: DraftSendSummary['resolvedFrom'];
  /** gmail_update_draft with keepAttachments: false. */
  removesAttachments?: boolean;
  /** outlook_mail_reply only: whether the reply goes to everyone on the message. */
  replyAll?: boolean;
  /**
   * outlook_mail_reply only: the message could not be read, so `to` and `cc`
   * hold just the addresses the agent added — the thread's own are missing.
   */
  recipientsUnresolved?: boolean;
}

type Args = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

function bodyFromArgs(args: Args): string | undefined {
  if (typeof args.body === 'string' && args.body.length > 0) return args.body;
  if (typeof args.htmlBody === 'string' && args.htmlBody.length > 0) return htmlToText(args.htmlBody);
  return undefined;
}

/** The email an approval would send, or null for a tool that is not an email. */
export async function buildEmailApprovalSummary(
  approval: ApprovalRequest
): Promise<EmailApprovalSummary | null> {
  const args = (approval.arguments ?? {}) as Args;

  if (DRAFT_SEND_TOOLS.has(approval.tool)) {
    const draft = await resolveDraftSendSummary(approval);
    return {
      action: 'send_draft',
      account: draft?.account ?? str(args.account),
      draftId: str(args.draftId) ?? str(args.messageId),
      to: draft?.to,
      cc: draft?.cc,
      bcc: draft?.bcc,
      subject: draft?.subject,
      body: draft?.bodyPreview,
      resolved: draft !== null,
      source: draft?.resolvedFrom,
    };
  }

  if (!EMAIL_TOOLS.has(approval.tool)) return null;

  const isReply =
    approval.tool === 'outlook_mail_reply' || Boolean(args.threadId) || Boolean(args.replyTo);
  const action: EmailAction =
    approval.tool === 'gmail_update_draft'
      ? 'update_draft'
      : approval.tool === 'gmail_create_draft' || approval.tool === 'outlook_mail_create_draft'
      ? 'save_draft'
      : isReply
      ? 'reply'
      : 'send';

  const summary: EmailApprovalSummary = {
    action,
    account: str(args.account),
    to: joinRecipients(args.to) || undefined,
    cc: joinRecipients(args.cc) || undefined,
    bcc: joinRecipients(args.bcc) || undefined,
    subject: str(args.subject),
    body: bodyFromArgs(args),
    draftId: approval.tool === 'gmail_update_draft' ? str(args.draftId) : undefined,
    resolved: true,
    removesAttachments: approval.tool === 'gmail_update_draft' && args.keepAttachments === false,
  };

  // An Outlook reply names only the message it answers. Who it reaches is
  // decided by that message, not by the arguments, so it is worked out here.
  if (approval.tool === 'outlook_mail_reply') {
    const reply = await resolveOutlookReplySummary(approval);
    summary.to = reply.to;
    summary.cc = reply.cc;
    summary.bcc = reply.bcc;
    summary.subject ??= reply.subject;
    summary.replyAll = reply.replyAll;
    summary.recipientsUnresolved = !reply.resolved || undefined;
    if (reply.resolved) summary.inReplyTo = { subject: reply.inReplyToSubject, from: reply.from };
  }

  return summary;
}

/**
 * Who an outlook_mail_reply approval would deliver to.
 *
 * Mirrors handleReplyToMessage in servers/src/outlook-mail/handlers.ts: the
 * sender (or the message's Reply-To), plus its To and Cc unless replyAll is
 * false, plus whatever the agent added, each address once and the owner's own
 * left out. It is a prediction made before Graph builds the reply; the tool
 * result reports the recipients actually used.
 */
export async function resolveOutlookReplySummary(approval: ApprovalRequest): Promise<ReplySummary> {
  const args = (approval.arguments ?? {}) as Args;
  const replyAll = args.replyAll !== false;
  const added = (value: unknown): GraphRecipient[] =>
    (Array.isArray(value) ? value : typeof value === 'string' ? [value] : [])
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .map((address) => ({ emailAddress: { address: address.trim() } }));

  const messageId = str(args.messageId);
  const original = messageId
    ? await fetchOutlookThreadMessage(approval.agentId, messageId, str(args.account))
    : null;

  const seen = new Set<string>();
  const unique = (list: GraphRecipient[]): string | undefined =>
    graphRecipients(
      list.filter((r) => {
        const key = r.emailAddress?.address?.trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
    );

  if (!original) {
    return {
      replyAll,
      resolved: false,
      to: unique(added(args.to)),
      cc: unique(added(args.cc)),
      bcc: unique(added(args.bcc)),
    };
  }

  const own = original.ownEmail?.toLowerCase();
  const notOwn = (r: GraphRecipient) => !own || r.emailAddress?.address?.trim().toLowerCase() !== own;
  const answered = original.replyTo.length > 0 ? original.replyTo : original.from ? [original.from] : [];

  const to = unique([...answered, ...(replyAll ? original.to.filter(notOwn) : []), ...added(args.to)]);
  const cc = unique([...(replyAll ? original.cc.filter(notOwn) : []), ...added(args.cc)]);
  const bcc = unique(added(args.bcc));

  const subject = original.subject
    ? /^re:/i.test(original.subject)
      ? original.subject
      : `Re: ${original.subject}`
    : undefined;

  return {
    replyAll,
    resolved: true,
    to,
    cc,
    bcc,
    subject,
    from: original.from ? graphRecipients([original.from]) : undefined,
    inReplyToSubject: original.subject,
  };
}

/**
 * What a send-draft approval would deliver. Gmail drafts are named by
 * `draftId` (or the jobId of the approval that created the draft); Outlook
 * drafts by `messageId`.
 */
export async function resolveDraftSendSummary(approval: ApprovalRequest): Promise<DraftSendSummary | null> {
  const args = (approval.arguments ?? {}) as Args;
  const account = str(args.account);
  if (approval.tool === 'outlook_mail_send_draft') {
    const messageId = str(args.messageId);
    if (!messageId) return null;
    const msg = await fetchOutlookMessage(approval.agentId, messageId, account);
    if (!msg) return null;
    return {
      to: msg.to,
      cc: msg.cc,
      bcc: msg.bcc,
      subject: msg.subject,
      bodyPreview: msg.body,
      account,
      resolvedFrom: 'outlook',
    };
  }
  const draftId = str(args.draftId);
  if (!draftId) return null;
  return resolveGmailDraftSummary(approval.agentId, draftId, account);
}

type CreatingRow = {
  id?: string;
  tool?: string;
  agent_id?: string;
  arguments_json?: string | null;
  result_json?: string | null;
};

/**
 * What one Gmail draft currently contains, by draft id (or by the jobId of the
 * approval that created it).
 */
export async function resolveGmailDraftSummary(
  agentId: string,
  draftId: string,
  account?: string
): Promise<DraftSendSummary | null> {
  try {
    // 1. draftId is the create_draft approval's own jobId.
    const byId = await client.execute({
      sql: `SELECT id, tool, agent_id, arguments_json, result_json FROM approvals WHERE id = ?`,
      args: [draftId],
    });
    let creating: CreatingRow | undefined;
    const row = byId.rows[0] as CreatingRow | undefined;
    if (row && row.tool === 'gmail_create_draft' && row.agent_id === agentId) {
      creating = row;
    }

    // 2. Or the real Gmail id an executed create_draft returned.
    if (!creating) {
      const byResult = await client.execute({
        sql: `SELECT id, arguments_json, result_json FROM approvals
              WHERE agent_id = ? AND tool = 'gmail_create_draft' AND result_json LIKE ?
              ORDER BY requested_at DESC LIMIT 1`,
        args: [agentId, `%${draftId}%`],
      });
      creating = byResult.rows[0] as CreatingRow | undefined;
    }

    // The id Gmail knows the draft by. `draftId` may be a jobId instead.
    let gmailDraftId = draftId;
    if (creating?.result_json) {
      try {
        const created = JSON.parse(creating.result_json) as { data?: { draftId?: string } };
        if (typeof created.data?.draftId === 'string') gmailDraftId = created.data.draftId;
      } catch { /* fall back to the id as given */ }
    }

    // The creating approval's arguments describe the draft as it was first
    // written. If gmail_update_draft has touched it since, they describe a
    // version that no longer exists, and replaying them would have the owner
    // approve a send while reading the old text. Read it live instead.
    const argsJson = creating?.arguments_json ?? null;
    const edited =
      argsJson !== null && (await draftWasEdited(agentId, [draftId, gmailDraftId, creating?.id]));

    if (argsJson && !edited) {
      const created = JSON.parse(argsJson) as Args;
      return {
        to: joinRecipients(created.to) || undefined,
        cc: joinRecipients(created.cc) || undefined,
        bcc: joinRecipients(created.bcc) || undefined,
        subject: str(created.subject),
        bodyPreview: bodyFromArgs(created),
        account: str(created.account) ?? account,
        resolvedFrom: 'creation-approval',
      };
    }

    // 3. A draft created without an approval (create_draft runs unattended by
    //    default), one Reins did not create, or one edited since — read Gmail.
    const token = await accessTokenFor(agentId, 'gmail', account);
    if (!token) return null;
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(gmailDraftId)}?format=full`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) }
    );
    if (!res.ok) return null;
    const draft = (await res.json()) as { message?: GmailMessage };
    const headers = draft.message?.payload?.headers ?? [];
    const header = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || undefined;
    return {
      to: header('To'),
      cc: header('Cc'),
      bcc: header('Bcc'),
      subject: header('Subject'),
      bodyPreview: gmailBodyText(draft.message?.payload) ?? (draft.message?.snippet || undefined),
      account,
      resolvedFrom: 'gmail',
    };
  } catch (err) {
    console.warn('[email-summary] could not resolve Gmail draft:', err);
    return null;
  }
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: Array<{ name?: string; value?: string }>;
}
interface GmailMessage {
  snippet?: string;
  payload?: GmailPart;
}

/** The draft's text/plain body, else its text/html body as text. */
function gmailBodyText(payload: GmailPart | undefined): string | undefined {
  if (!payload) return undefined;
  const find = (part: GmailPart, mime: string): string | undefined => {
    if (part.mimeType === mime && part.body?.data) return part.body.data;
    for (const child of part.parts ?? []) {
      const hit = find(child, mime);
      if (hit) return hit;
    }
    return undefined;
  };
  const decode = (data: string) => Buffer.from(data, 'base64url').toString('utf8');
  const plain = find(payload, 'text/plain');
  if (plain) return decode(plain);
  const html = find(payload, 'text/html');
  return html ? htmlToText(decode(html)) : undefined;
}

/**
 * Whether gmail_update_draft has run against this draft.
 *
 * Checked in the audit log as well as the approvals table: an owner can set
 * the tool to run without approval, and those calls leave no approval row.
 * `ids` are the ways the draft may have been named — its Gmail id, and the
 * jobId of the approval that created it.
 */
async function draftWasEdited(agentId: string, ids: Array<string | undefined>): Promise<boolean> {
  const known = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))];
  for (const id of known) {
    // The id is matched inside its JSON quotes so one id cannot match as a
    // substring of another.
    const pattern = `%"${id}"%`;
    const hit = await client.execute({
      sql: `SELECT 1 AS edited FROM approvals
            WHERE agent_id = ? AND tool = 'gmail_update_draft'
              AND result_json IS NOT NULL AND arguments_json LIKE ?
            UNION ALL
            SELECT 1 AS edited FROM audit_log
            WHERE agent_id = ? AND tool = 'gmail_update_draft'
              AND result = 'success' AND arguments_json LIKE ?
            LIMIT 1`,
      args: [agentId, pattern, agentId, pattern],
    });
    if (hit.rows.length > 0) return true;
  }
  return false;
}

interface OutlookMessageSummary {
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
}

type GraphRecipient = { emailAddress?: { name?: string; address?: string } };

function graphRecipients(list: GraphRecipient[] | undefined): string | undefined {
  const out = (list ?? [])
    .map((r) => {
      const { name, address } = r.emailAddress ?? {};
      if (name && address && name !== address) return `${name} <${address}>`;
      return address ?? name ?? '';
    })
    .filter(Boolean)
    .join(', ');
  return out || undefined;
}

/** The message a reply answers, with its recipients kept apart so they can be merged. */
async function fetchOutlookThreadMessage(
  agentId: string,
  messageId: string,
  account?: string
): Promise<{
  subject?: string;
  from?: GraphRecipient;
  replyTo: GraphRecipient[];
  to: GraphRecipient[];
  cc: GraphRecipient[];
  ownEmail?: string;
} | null> {
  try {
    const credential = await credentialFor(agentId, 'outlook_mail', account);
    if (!credential) return null;
    const res = await fetch(
      `${GRAPH_API}/me/messages/${encodeURIComponent(messageId)}` +
        `?$select=subject,from,replyTo,toRecipients,ccRecipients`,
      {
        headers: { Authorization: `Bearer ${credential.token}` },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      }
    );
    if (!res.ok) return null;
    const msg = (await res.json()) as {
      subject?: string;
      from?: GraphRecipient;
      replyTo?: GraphRecipient[];
      toRecipients?: GraphRecipient[];
      ccRecipients?: GraphRecipient[];
    };
    return {
      subject: msg.subject || undefined,
      from: msg.from,
      replyTo: msg.replyTo ?? [],
      to: msg.toRecipients ?? [],
      cc: msg.ccRecipients ?? [],
      ownEmail: credential.email,
    };
  } catch (err) {
    console.warn('[email-summary] could not read the message being replied to:', err);
    return null;
  }
}

/** An Outlook draft, read live from Graph. */
async function fetchOutlookMessage(
  agentId: string,
  messageId: string,
  account?: string
): Promise<OutlookMessageSummary | null> {
  try {
    const token = await accessTokenFor(agentId, 'outlook_mail', account);
    if (!token) return null;
    const res = await fetch(
      `${GRAPH_API}/me/messages/${encodeURIComponent(messageId)}` +
        `?$select=subject,from,toRecipients,ccRecipients,bccRecipients,body`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          // Ask Graph for the body as text rather than stripping HTML here.
          Prefer: 'outlook.body-content-type="text"',
        },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      }
    );
    if (!res.ok) return null;
    const msg = (await res.json()) as {
      subject?: string;
      from?: GraphRecipient;
      toRecipients?: GraphRecipient[];
      ccRecipients?: GraphRecipient[];
      bccRecipients?: GraphRecipient[];
      body?: { contentType?: string; content?: string };
    };
    const content = msg.body?.content;
    return {
      from: msg.from ? graphRecipients([msg.from]) : undefined,
      to: graphRecipients(msg.toRecipients),
      cc: graphRecipients(msg.ccRecipients),
      bcc: graphRecipients(msg.bccRecipients),
      subject: msg.subject || undefined,
      body: content
        ? (msg.body?.contentType === 'html' ? htmlToText(content) : content.trim()) || undefined
        : undefined,
    };
  } catch (err) {
    console.warn('[email-summary] could not read Outlook message:', err);
    return null;
  }
}

/** Access token for the agent's credential on `serviceType` matching `account`, else its default. */
async function accessTokenFor(
  agentId: string,
  serviceType: 'gmail' | 'outlook_mail',
  account?: string
): Promise<string | null> {
  return (await credentialFor(agentId, serviceType, account))?.token ?? null;
}

/** As accessTokenFor, with the address of the mailbox the token belongs to. */
export async function credentialFor(
  agentId: string,
  serviceType: 'gmail' | 'outlook_mail' | 'calendar' | 'outlook_calendar',
  account?: string
): Promise<{ token: string; email?: string } | null> {
  const rows = await client.execute({
    sql: `SELECT asi.credential_id, asi.is_default, c.account_email
          FROM agent_service_instances asi
          JOIN credentials c ON c.id = asi.credential_id
          WHERE asi.agent_id = ? AND asi.service_type = ? AND asi.enabled = true`,
    args: [agentId, serviceType],
  });
  const instances = rows.rows as Array<{
    credential_id: string;
    is_default: boolean | number;
    account_email: string | null;
  }>;
  if (instances.length === 0) return null;
  const match = account
    ? instances.find((i) => i.account_email === account)
    : instances.find((i) => i.is_default === true || i.is_default === 1) ?? instances[0];
  if (!match) return null;
  const token = await credentialVault.getValidAccessToken(match.credential_id);
  return token ? { token, email: match.account_email ?? undefined } : null;
}
