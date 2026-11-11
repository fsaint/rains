/**
 * Outlook Mail MCP Server Tool Handlers
 *
 * Uses the Microsoft Graph API with an OAuth2 access token.
 */

import type { ServerContext, ToolResult } from '../common/types.js';
import { AttachmentError } from '../gmail/attachments.js';
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

export async function handleReplyToMessage(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const messageId = args.messageId as string;
  const comment = args.body as string;

  const response = await graphRequest(context, `/me/messages/${messageId}/reply`, {
    method: 'POST',
    body: JSON.stringify({ comment }),
  });

  if (!response.ok && response.status !== 202) return handleError(response);

  return { success: true, data: { replied: true, messageId } };
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
