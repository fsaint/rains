/**
 * Outlook Mail MCP Server Tool Handlers
 *
 * Uses the Microsoft Graph API with an OAuth2 access token.
 */

import type { ServerContext, ToolResult } from '../common/types.js';
import { AttachmentError } from '../gmail/attachments.js';
import { MAX_INLINE_DOWNLOAD_BYTES, formatBytes } from '../gmail/limits.js';
import type { ResolvedAttachment } from '../gmail/mime.js';
import {
  addAttachmentToDraft,
  listMessageAttachments,
  resolveOutlookAttachments,
  type OutlookAttachmentInfo,
} from './attachments.js';

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

// ============================================================================
// Account tools
// ============================================================================

export async function handleGetProfile(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const response = await graphRequest(context, '/me?$select=displayName,mail,userPrincipalName');
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return {
    success: true,
    data: {
      displayName: data.displayName,
      email: data.mail || data.userPrincipalName,
    },
  };
}

// ============================================================================
// Message tools
// ============================================================================

export async function handleListMessages(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const top = Math.min((args.maxResults as number) || 10, 100);
  const filter = args.filter as string | undefined;
  const select = 'id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview';

  const params = new URLSearchParams({ $top: String(top), $select: select, $orderby: 'receivedDateTime desc' });
  if (filter) params.set('$filter', filter);

  const folder = (args.folder as string) || 'inbox';
  const response = await graphRequest(context, `/me/mailFolders/${folder}/messages?${params}`);
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return {
    success: true,
    data: data.value?.map((m: any) => ({
      id: m.id,
      subject: m.subject,
      from: m.from?.emailAddress?.address,
      to: m.toRecipients?.map((r: any) => r.emailAddress?.address),
      receivedDateTime: m.receivedDateTime,
      isRead: m.isRead,
      bodyPreview: m.bodyPreview,
    })),
  };
}

export async function handleGetMessage(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const messageId = args.messageId as string;
  const response = await graphRequest(context, `/me/messages/${messageId}`);
  if (!response.ok) return handleError(response);

  const m = await response.json();

  // Name the files, not just flag that some exist: source="outlook" forwards
  // one by filename, and the agent has nowhere else to learn the names.
  let attachments: OutlookAttachmentInfo[] = [];
  if (m.hasAttachments) {
    try {
      attachments = await listMessageAttachments((path, options) => graphRequest(context, path, options), messageId);
    } catch {
      // The message itself was read; a failed listing must not hide it.
    }
  }

  return {
    success: true,
    data: {
      id: m.id,
      subject: m.subject,
      from: m.from?.emailAddress,
      to: m.toRecipients?.map((r: any) => r.emailAddress),
      cc: m.ccRecipients?.map((r: any) => r.emailAddress),
      receivedDateTime: m.receivedDateTime,
      isRead: m.isRead,
      body: m.body?.content,
      bodyContentType: m.body?.contentType,
      hasAttachments: m.hasAttachments,
      attachments,
    },
  };
}

/**
 * Download one attachment from a message.
 *
 * Returns a signed download link rather than the bytes, so a large file never
 * enters the model's context; files at or under MAX_INLINE_DOWNLOAD_BYTES are
 * also inlined as base64. Without a link signer (no backend), base64 is the
 * only way to deliver the file, so it is inlined whatever the size.
 */
export async function handleGetAttachment(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const messageId = typeof args.messageId === 'string' ? args.messageId.trim() : '';
  if (!messageId) return { success: false, error: 'messageId is required.' };
  const filename = typeof args.filename === 'string' ? args.filename.trim() : '';
  const attachmentId = typeof args.attachmentId === 'string' ? args.attachmentId.trim() : '';

  const graph = (path: string, options?: RequestInit) => graphRequest(context, path, options);

  let available: OutlookAttachmentInfo[];
  try {
    available = await listMessageAttachments(graph, messageId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error:
        `Could not read the attachments of message "${messageId}": ${reason}. ` +
        'Check the messageId from outlook_mail_get_message or outlook_mail_search.',
    };
  }

  if (available.length === 0) {
    return { success: false, error: `Message "${messageId}" has no downloadable attachments.` };
  }

  const meta =
    (attachmentId ? available.find((entry) => entry.attachmentId === attachmentId) : undefined) ??
    (filename
      ? available.find((entry) => entry.filename === filename) ??
        available.find((entry) => entry.filename.toLowerCase() === filename.toLowerCase())
      : undefined) ??
    // Fall back to a lone attachment only when nothing was named: handing back
    // a different file than the one asked for is worse than refusing.
    (!filename && !attachmentId && available.length === 1 ? available[0] : undefined);

  if (!meta) {
    const listing = available
      .map((entry) => `"${entry.filename}" (${formatBytes(entry.size)})`)
      .join(', ');
    return {
      success: false,
      error:
        filename || attachmentId
          ? `Message "${messageId}" has no attachment ${filename ? `named "${filename}"` : `with id "${attachmentId}"`}. It has: ${listing}.`
          : `Message "${messageId}" has ${available.length} attachments: ${listing}. Pass "filename" to say which one you want.`,
    };
  }

  const link = context.signAttachmentUrl?.({
    messageId,
    attachmentId: meta.attachmentId,
    filename: meta.filename,
    mimeType: meta.mimeType,
    size: meta.size,
  });

  let data: string | undefined;
  if (!link || meta.size <= MAX_INLINE_DOWNLOAD_BYTES) {
    const response = await graph(
      `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(meta.attachmentId)}/$value`
    );
    if (!response.ok) return handleError(response);
    data = Buffer.from(await response.arrayBuffer()).toString('base64');
  }

  return {
    success: true,
    data: {
      messageId,
      attachmentId: meta.attachmentId,
      filename: meta.filename,
      mimeType: meta.mimeType,
      size: meta.size,
      ...(link
        ? {
            url: link.url,
            token: link.token,
            expiresAt: link.expiresAt,
            curl: link.curl,
            note:
              'Run `curl` to download the file. The bytes do not pass through this conversation. ' +
              'The token authorises this one attachment and expires shortly.',
          }
        : {}),
      ...(data === undefined ? {} : { encoding: 'base64', data }),
    },
  };
}

export async function handleSearchMessages(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const query = args.query as string;
  const top = Math.min((args.maxResults as number) || 20, 100);

  const params = new URLSearchParams({
    $search: `"${query}"`,
    $top: String(top),
    $select: 'id,subject,from,receivedDateTime,bodyPreview',
  });

  const response = await graphRequest(context, `/me/messages?${params}`);
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return {
    success: true,
    data: data.value?.map((m: any) => ({
      id: m.id,
      subject: m.subject,
      from: m.from?.emailAddress?.address,
      receivedDateTime: m.receivedDateTime,
      bodyPreview: m.bodyPreview,
    })),
  };
}

// ============================================================================
// Draft / Send tools
// ============================================================================

/** The Graph message resource for a new email, built from tool arguments. */
function buildMessage(args: Record<string, unknown>): Record<string, unknown> {
  const recipients = (emails: string[]) =>
    emails.map((email) => ({ emailAddress: { address: email } }));

  const message: Record<string, unknown> = {
    subject: args.subject,
    body: {
      contentType: args.htmlBody ? 'HTML' : 'Text',
      content: args.htmlBody || args.body || '',
    },
    toRecipients: recipients(args.to as string[]),
  };
  if (args.cc) message.ccRecipients = recipients(args.cc as string[]);
  if (args.bcc) message.bccRecipients = recipients(args.bcc as string[]);
  return message;
}

/**
 * Resolve the raw `attachments` argument, converting an AttachmentError into a
 * failed ToolResult so the model sees an actionable message.
 */
async function resolveAttachmentsOrFail(
  raw: unknown,
  context: ServerContext
): Promise<{ attachments: ResolvedAttachment[] } | { error: ToolResult }> {
  try {
    return {
      attachments: await resolveOutlookAttachments(
        raw,
        (path, options) => graphRequest(context, path, options),
        context.gatewayToken
      ),
    };
  } catch (error) {
    if (error instanceof AttachmentError) {
      return { error: { success: false, error: error.message } };
    }
    throw error;
  }
}

/**
 * Create a draft and put the resolved files on it.
 *
 * Graph has no single call for a draft with large attachments, so this is
 * create-then-attach. If any file fails the draft is deleted: a draft missing
 * an attachment looks finished and would be sent that way.
 */
async function createDraftWithAttachments(
  args: Record<string, unknown>,
  attachments: ResolvedAttachment[],
  context: ServerContext
): Promise<{ draft: { id: string; subject?: string } } | { error: ToolResult }> {
  const response = await graphRequest(context, '/me/messages', {
    method: 'POST',
    body: JSON.stringify(buildMessage(args)),
  });
  if (!response.ok) return { error: await handleError(response) };

  const draft = (await response.json()) as { id: string; subject?: string };

  for (const attachment of attachments) {
    try {
      await addAttachmentToDraft(
        (path, options) => graphRequest(context, path, options),
        draft.id,
        attachment
      );
    } catch (error) {
      const removed = await graphRequest(context, `/me/messages/${encodeURIComponent(draft.id)}`, {
        method: 'DELETE',
      }).catch(() => null);
      const cleanedUp = removed !== null && (removed.ok || removed.status === 204);
      return {
        error: {
          success: false,
          error:
            `Could not attach "${attachment.filename}": ${(error as Error).message}. ` +
            (cleanedUp
              ? 'No draft was left behind.'
              : `The incomplete draft "${draft.id}" could not be removed — tell the user to delete it.`),
        },
      };
    }
  }

  return { draft };
}

export async function handleCreateDraft(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  // Resolved before the draft exists, so a bad attachment creates nothing.
  const outcome = await resolveAttachmentsOrFail(args.attachments, context);
  if ('error' in outcome) return outcome.error;

  const created = await createDraftWithAttachments(args, outcome.attachments, context);
  if ('error' in created) return created.error;

  return {
    success: true,
    data: {
      id: created.draft.id,
      subject: created.draft.subject,
      ...(outcome.attachments.length > 0
        ? {
            attachments: outcome.attachments.map((attachment) => ({
              filename: attachment.filename,
              size: attachment.bytes.length,
            })),
          }
        : {}),
    },
  };
}

export async function handleSendDraft(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const messageId = args.messageId as string;

  const response = await graphRequest(context, `/me/messages/${messageId}/send`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

  if (!response.ok && response.status !== 202) return handleError(response);

  return { success: true, data: { sent: true, messageId } };
}

export async function handleSendMessage(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const outcome = await resolveAttachmentsOrFail(args.attachments, context);
  if ('error' in outcome) return outcome.error;

  if (outcome.attachments.length === 0) {
    const response = await graphRequest(context, '/me/sendMail', {
      method: 'POST',
      body: JSON.stringify({ message: buildMessage(args), saveToSentItems: true }),
    });

    if (!response.ok && response.status !== 202) return handleError(response);

    return { success: true, data: { sent: true } };
  }

  // sendMail carries attachments inline and so caps the whole request near
  // 4 MB. Building a draft first lifts that to the same limits as a draft.
  const created = await createDraftWithAttachments(args, outcome.attachments, context);
  if ('error' in created) return created.error;

  const response = await graphRequest(
    context,
    `/me/messages/${encodeURIComponent(created.draft.id)}/send`,
    { method: 'POST', body: JSON.stringify({}) }
  );
  if (!response.ok && response.status !== 202) return handleError(response);

  return {
    success: true,
    data: {
      sent: true,
      attachments: outcome.attachments.map((attachment) => ({
        filename: attachment.filename,
        size: attachment.bytes.length,
      })),
    },
  };
}

type GraphRecipient = { emailAddress?: { address?: string; name?: string } };

const addressOf = (recipient: GraphRecipient): string => recipient.emailAddress?.address?.trim() ?? '';

/** A `to` / `cc` / `bcc` argument as a list of addresses, or null when it is not one. */
function addressList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')) return null;
  return (list as string[]).map((entry) => entry.trim()).filter(Boolean);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Plain text as HTML that renders the same line breaks. */
function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>');
}

/**
 * Put the reply above what Graph quoted. The quoted message is a whole HTML
 * document, so the reply goes inside its <body> rather than in front of it.
 */
function prependToQuoted(replyHtml: string, quoted: { contentType?: string; content?: string } | undefined): string {
  const block = `<div>${replyHtml}</div>`;
  const content = quoted?.content ?? '';
  if (!content) return block;
  if (quoted?.contentType?.toLowerCase() !== 'html') return `${block}<br><div>${textToHtml(content)}</div>`;
  const body = /<body[^>]*>/i.exec(content);
  if (!body) return `${block}${content}`;
  const at = body.index + body[0].length;
  return `${content.slice(0, at)}${block}${content.slice(at)}`;
}

/**
 * Reply to a message.
 *
 * Graph's one-call /reply and /replyAll return nothing, so the caller could
 * not be told who received the reply — and a reply that silently dropped the
 * thread's Cc is how this tool used to fail. The reply is therefore built as a
 * draft: Graph addresses it, the extra recipients and the body are set on it,
 * and it is sent. If any step fails the draft is deleted, because an unsent
 * reply left in Drafts looks like one that went out.
 */
export async function handleReplyToMessage(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const messageId = typeof args.messageId === 'string' ? args.messageId.trim() : '';
  if (!messageId) return { success: false, error: 'messageId is required.' };

  const htmlBody = typeof args.htmlBody === 'string' && args.htmlBody.trim() ? args.htmlBody : '';
  const textBody = typeof args.body === 'string' && args.body.trim() ? args.body : '';
  if (!htmlBody && !textBody) {
    return { success: false, error: 'A reply needs a body: pass "body" (plain text) or "htmlBody".' };
  }

  const extra: Record<'to' | 'cc' | 'bcc', string[]> = { to: [], cc: [], bcc: [] };
  for (const field of ['to', 'cc', 'bcc'] as const) {
    const list = addressList(args[field]);
    if (!list) return { success: false, error: `"${field}" must be a list of email addresses.` };
    extra[field] = list;
  }

  const replyAll = args.replyAll !== false;

  const created = await graphRequest(
    context,
    `/me/messages/${encodeURIComponent(messageId)}/${replyAll ? 'createReplyAll' : 'createReply'}`,
    { method: 'POST', body: JSON.stringify({}) }
  );
  if (!created.ok) return handleError(created);

  const draft = (await created.json()) as {
    id: string;
    from?: GraphRecipient;
    toRecipients?: GraphRecipient[];
    ccRecipients?: GraphRecipient[];
    body?: { contentType?: string; content?: string };
  };

  // One address appears once: To wins over Cc, and both over Bcc.
  const seen = new Set<string>();
  const unique = (list: GraphRecipient[]): GraphRecipient[] =>
    list.filter((recipient) => {
      const key = addressOf(recipient).toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const added = (emails: string[]): GraphRecipient[] => emails.map((address) => ({ emailAddress: { address } }));

  // Graph normally leaves the mailbox owner out of a reply-all; this makes it
  // certain. A reply whose only recipient is the owner (a note to self) keeps it.
  const own = draft.from ? addressOf(draft.from).toLowerCase() : '';
  const notOwn = (recipient: GraphRecipient) => !own || addressOf(recipient).toLowerCase() !== own;
  const threadTo = draft.toRecipients ?? [];
  const threadCc = (draft.ccRecipients ?? []).filter(notOwn);
  const others = [...threadTo.filter(notOwn), ...threadCc, ...added(extra.to), ...added(extra.cc)];

  const to = unique([...(others.length > 0 ? threadTo.filter(notOwn) : threadTo), ...added(extra.to)]);
  const cc = unique([...threadCc, ...added(extra.cc)]);
  const bcc = unique(added(extra.bcc));

  const draftPath = `/me/messages/${encodeURIComponent(draft.id)}`;
  const fail = async (response: Response): Promise<ToolResult> => {
    const failure = await handleError(response);
    const removed = await graphRequest(context, draftPath, { method: 'DELETE' }).catch(() => null);
    const cleanedUp = removed !== null && (removed.ok || removed.status === 204);
    return {
      success: false,
      error:
        `The reply was not sent. ${failure.error}. ` +
        (cleanedUp
          ? 'No draft was left behind.'
          : `The unsent draft "${draft.id}" could not be removed — tell the user to delete it.`),
    };
  };

  const updated = await graphRequest(context, draftPath, {
    method: 'PATCH',
    body: JSON.stringify({
      toRecipients: to,
      ccRecipients: cc,
      bccRecipients: bcc,
      body: {
        contentType: 'HTML',
        content: prependToQuoted(htmlBody || textToHtml(textBody), draft.body),
      },
    }),
  });
  if (!updated.ok) return fail(updated);

  const sent = await graphRequest(context, `${draftPath}/send`, { method: 'POST', body: JSON.stringify({}) });
  if (!sent.ok && sent.status !== 202) return fail(sent);

  return {
    success: true,
    data: {
      replied: true,
      messageId,
      replyAll,
      to: to.map(addressOf),
      cc: cc.map(addressOf),
      ...(bcc.length > 0 ? { bcc: bcc.map(addressOf) } : {}),
    },
  };
}

// ============================================================================
// Delete / manage tools
// ============================================================================

export async function handleDeleteMessage(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const messageId = args.messageId as string;

  const response = await graphRequest(context, `/me/messages/${messageId}`, {
    method: 'DELETE',
  });

  if (!response.ok && response.status !== 204) return handleError(response);

  return { success: true, data: { deleted: true, messageId } };
}

export async function handleMoveMessage(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const messageId = args.messageId as string;
  const destinationFolder = args.destinationFolder as string;

  const response = await graphRequest(context, `/me/messages/${messageId}/move`, {
    method: 'POST',
    body: JSON.stringify({ destinationId: destinationFolder }),
  });
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return { success: true, data: { id: data.id, movedTo: destinationFolder } };
}

// ============================================================================
// Folder tools
// ============================================================================

export async function handleListFolders(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const response = await graphRequest(context, '/me/mailFolders?$top=50');
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return {
    success: true,
    data: data.value?.map((f: any) => ({
      id: f.id,
      displayName: f.displayName,
      totalItemCount: f.totalItemCount,
      unreadItemCount: f.unreadItemCount,
    })),
  };
}

/**
 * Validate a Microsoft access token by calling /me
 */
export async function validateToken(token: string): Promise<{
  valid: boolean;
  email?: string;
  displayName?: string;
  error?: string;
}> {
  try {
    const response = await fetch(`${GRAPH_API}/me?$select=displayName,mail,userPrincipalName`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      return { valid: false, error: `Authentication failed (${response.status})` };
    }

    const data = await response.json();
    return { valid: true, email: data.mail || data.userPrincipalName, displayName: data.displayName };
  } catch (error) {
    return { valid: false, error: String(error) };
  }
}
