/**
 * Gmail MCP Server Tool Handlers
 */

import { google, type drive_v3, type gmail_v1 } from 'googleapis';
import type { ServerContext, ToolResult } from '../common/types.js';
import { buildMimeMessage, toRawBase64Url, type ResolvedAttachment } from './mime.js';
import {
  AttachmentError,
  collectAttachmentParts,
  parseAndResolveAttachments,
} from './attachments.js';

type GmailClient = gmail_v1.Gmail;

/**
 * Get Gmail client from context
 */
function getGmailClient(context: ServerContext): GmailClient {
  if (!context.accessToken) {
    throw new Error('No access token available');
  }

  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: context.accessToken });
  return google.gmail({ version: 'v1', auth });
}

/** Drive client for the drive attachment source, using the same Google token. */
function getDriveClient(context: ServerContext): drive_v3.Drive {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: context.accessToken });
  return google.drive({ version: 'v3', auth });
}

/**
 * Parse email address header
 */
function parseEmailHeader(
  headers: gmail_v1.Schema$MessagePartHeader[],
  name: string
): string | undefined {
  const value = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
    ?.value;
  return value ?? undefined;
}

/**
 * Decode base64 URL-safe string
 */
function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/**
 * Resolve the raw `attachments` argument, converting an AttachmentError into a
 * failed ToolResult so the model sees an actionable message rather than a stack
 * trace. Returns null when resolution failed.
 */
async function resolveAttachmentsOrFail(
  raw: unknown,
  gmail: GmailClient,
  context: ServerContext
): Promise<{ attachments: ResolvedAttachment[] } | { error: ToolResult }> {
  try {
    return {
      attachments: await parseAndResolveAttachments(raw, {
        gmail,
        // The default Google grant carries drive.readonly alongside the Gmail
        // scopes, so the same token can read a file to attach. Folder rules are
        // enforced by the resolver.
        drive: context.accessToken ? () => getDriveClient(context) : undefined,
        driveDefaultLevel: context.driveDefaultLevel,
        drivePathRules: context.drivePathRules,
        gatewayToken: context.gatewayToken,
      }),
    };
  } catch (error) {
    if (error instanceof AttachmentError) {
      return { error: { success: false, error: error.message } };
    }
    throw error;
  }
}

/**
 * Extract message content from parts
 */
function extractMessageContent(
  payload: gmail_v1.Schema$MessagePart
): { text?: string; html?: string } {
  const result: { text?: string; html?: string } = {};

  if (payload.body?.data) {
    if (payload.mimeType === 'text/plain') {
      result.text = decodeBase64Url(payload.body.data);
    } else if (payload.mimeType === 'text/html') {
      result.html = decodeBase64Url(payload.body.data);
    }
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const content = extractMessageContent(part);
      if (content.text) result.text = content.text;
      if (content.html) result.html = content.html;
    }
  }

  return result;
}

/**
 * List messages handler
 */
export async function handleListMessages(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const gmail = getGmailClient(context);

  const query = args.query as string | undefined;
  const maxResults = Math.min((args.maxResults as number) ?? 10, 100);
  const labelIds = args.labelIds as string[] | undefined;
  const pageToken = args.pageToken as string | undefined;

  const response = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults,
    labelIds,
    pageToken,
  });

  const messages = response.data.messages ?? [];

  // Fetch snippets for each message
  const messagesWithSnippets = await Promise.all(
    messages.map(async (msg) => {
      if (!msg.id) return { id: msg.id, snippet: '' };

      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });

      const headers = detail.data.payload?.headers ?? [];
      return {
        id: msg.id,
        threadId: msg.threadId,
        snippet: detail.data.snippet,
        from: parseEmailHeader(headers, 'From'),
        subject: parseEmailHeader(headers, 'Subject'),
        date: parseEmailHeader(headers, 'Date'),
      };
    })
  );

  return {
    success: true,
    data: {
      messages: messagesWithSnippets,
      nextPageToken: response.data.nextPageToken,
      resultSizeEstimate: response.data.resultSizeEstimate,
    },
  };
}

/**
 * Get message handler
 */
export async function handleGetMessage(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const gmail = getGmailClient(context);

  const messageId = args.messageId as string;
  const format = (args.format as string) ?? 'full';

  const response = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: format as 'minimal' | 'full' | 'raw' | 'metadata',
  });

  const message = response.data;
  const headers = message.payload?.headers ?? [];

  // Extract content
  const content = message.payload
    ? extractMessageContent(message.payload)
    : {};

  // Extract attachment metadata (shared with the gmail attachment resolver)
  const attachments = message.payload ? collectAttachmentParts(message.payload) : [];

  return {
    success: true,
    data: {
      id: message.id,
      threadId: message.threadId,
      labelIds: message.labelIds,
      snippet: message.snippet,
      from: parseEmailHeader(headers, 'From'),
      to: parseEmailHeader(headers, 'To'),
      cc: parseEmailHeader(headers, 'Cc'),
      subject: parseEmailHeader(headers, 'Subject'),
      date: parseEmailHeader(headers, 'Date'),
      body: content.text ?? content.html,
      isHtml: !!content.html && !content.text,
      attachments,
    },
  };
}

/**
 * Get attachment handler
 */
export async function handleGetAttachment(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const gmail = getGmailClient(context);

  const messageId = args.messageId as string;
  const attachmentId = args.attachmentId as string;

  const response = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });

  const data = response.data.data ?? '';
  const size = response.data.size ?? 0;

  return {
    success: true,
    data: {
      attachmentId,
      messageId,
      size,
      encoding: 'base64url',
      data,
    },
  };
}

/**
 * Search handler
 */
export async function handleSearch(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const gmail = getGmailClient(context);

  const query = args.query as string;
  const maxResults = Math.min((args.maxResults as number) ?? 20, 100);
  const includeSpamTrash = args.includeSpamTrash as boolean | undefined;

  const response = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults,
    includeSpamTrash,
  });

  const messages = response.data.messages ?? [];

  // Fetch details for each message
  const results = await Promise.all(
    messages.map(async (msg) => {
      if (!msg.id) return null;

      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });

      const headers = detail.data.payload?.headers ?? [];
      return {
        id: msg.id,
        threadId: msg.threadId,
        snippet: detail.data.snippet,
        from: parseEmailHeader(headers, 'From'),
        subject: parseEmailHeader(headers, 'Subject'),
        date: parseEmailHeader(headers, 'Date'),
      };
    })
  );

  return {
    success: true,
    data: {
      query,
      results: results.filter(Boolean),
      total: response.data.resultSizeEstimate,
    },
  };
}

/**
 * Create draft handler
 */
export async function handleCreateDraft(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const gmail = getGmailClient(context);

  const to = args.to as string[];
  const cc = args.cc as string[] | undefined;
  const bcc = args.bcc as string[] | undefined;
  const subject = args.subject as string;
  const body = args.body as string | undefined;
  const htmlBody = args.htmlBody as string | undefined;
  const replyTo = args.replyTo as string | undefined;
  const threadId = args.threadId as string | undefined;
  const outcome = await resolveAttachmentsOrFail(args.attachments, gmail, context);
  if ('error' in outcome) return outcome.error;

  const raw = toRawBase64Url(
    buildMimeMessage({
      to,
      cc,
      bcc,
      subject,
      body,
      htmlBody,
      replyTo,
      attachments: outcome.attachments,
    })
  );

  const response = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: {
        raw,
        threadId,
      },
    },
  });

  return {
    success: true,
    data: {
      draftId: response.data.id,
      messageId: response.data.message?.id,
      threadId: response.data.message?.threadId,
      message: 'Draft created successfully',
    },
  };
}

/**
 * Send draft handler
 */
export async function handleSendDraft(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const gmail = getGmailClient(context);

  const draftId = args.draftId as string;

  const response = await gmail.users.drafts.send({
    userId: 'me',
    requestBody: {
      id: draftId,
    },
  });

  return {
    success: true,
    data: {
      messageId: response.data.id,
      threadId: response.data.threadId,
      labelIds: response.data.labelIds,
      message: 'Draft sent successfully',
    },
  };
}

/**
 * Send message handler
 */
export async function handleSendMessage(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const gmail = getGmailClient(context);

  const to = args.to as string[];
  const cc = args.cc as string[] | undefined;
  const bcc = args.bcc as string[] | undefined;
  const subject = args.subject as string;
  const body = args.body as string | undefined;
  const htmlBody = args.htmlBody as string | undefined;
  const replyTo = args.replyTo as string | undefined;
  const threadId = args.threadId as string | undefined;
  const outcome = await resolveAttachmentsOrFail(args.attachments, gmail, context);
  if ('error' in outcome) return outcome.error;

  const raw = toRawBase64Url(
    buildMimeMessage({
      to,
      cc,
      bcc,
      subject,
      body,
      htmlBody,
      replyTo,
      attachments: outcome.attachments,
    })
  );

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw,
      threadId,
    },
  });

  return {
    success: true,
    data: {
      messageId: response.data.id,
      threadId: response.data.threadId,
      labelIds: response.data.labelIds,
      message: 'Message sent successfully',
    },
  };
}

/**
 * Delete message handler
 */
export async function handleDeleteMessage(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const gmail = getGmailClient(context);

  const messageId = args.messageId as string;

  await gmail.users.messages.delete({
    userId: 'me',
    id: messageId,
  });

  return {
    success: true,
    data: {
      messageId,
      message: 'Message deleted permanently',
    },
  };
}

/**
 * List linked accounts handler
 */
export async function handleListAccounts(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  return {
    success: true,
    data: { accounts: context.linkedAccounts ?? [] },
  };
}

/**
 * Gmail applies batchModify to at most 1000 ids per request; larger sets are
 * chunked. https://developers.google.com/gmail/api/reference/rest/v1/users.messages/batchModify
 */
export const GMAIL_BATCH_MODIFY_MAX = 1000;

/**
 * Accept either the singular `messageId` or the plural `messageIds`.
 *
 * The singular form predates batching and is still what most callers and stored
 * skill text use, so it stays supported rather than being migrated.
 */
function resolveMessageIds(args: Record<string, unknown>): string[] | { error: string } {
  const plural = args.messageIds;
  if (Array.isArray(plural)) {
    const ids = plural.filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length === 0) {
      // An empty array almost always means the caller's upstream search came
      // back empty; silently succeeding would look like the labels were applied.
      return { error: 'messageIds was empty — pass at least one message id.' };
    }
    return ids;
  }

  const single = args.messageId;
  if (typeof single === 'string' && single.length > 0) return [single];

  return { error: 'Provide messageId (one message) or messageIds (many).' };
}

/**
 * Apply the same label change to one or many messages.
 *
 * One id uses users.messages.modify, which returns the resulting labels. More
 * than one uses users.messages.batchModify, which returns no body at all — so
 * callers get a count instead of per-message labels.
 */
async function applyLabelChange(
  gmail: ReturnType<typeof getGmailClient>,
  ids: string[],
  addLabelIds: string[],
  removeLabelIds: string[]
): Promise<{ labelIds?: string[] | null; modifiedCount: number }> {
  if (ids.length === 1) {
    const response = await gmail.users.messages.modify({
      userId: 'me',
      id: ids[0],
      requestBody: { addLabelIds, removeLabelIds },
    });
    return { labelIds: response.data.labelIds, modifiedCount: 1 };
  }

  for (let i = 0; i < ids.length; i += GMAIL_BATCH_MODIFY_MAX) {
    await gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids: ids.slice(i, i + GMAIL_BATCH_MODIFY_MAX),
        addLabelIds,
        removeLabelIds,
      },
    });
  }

  return { modifiedCount: ids.length };
}

/**
 * Shape the result so single-message callers keep the response they had before
 * batching existed, and batch callers get a count.
 */
function labelChangeResult(
  ids: string[],
  outcome: { labelIds?: string[] | null; modifiedCount: number },
  singular: string,
  plural: (n: number) => string
): ToolResult {
  if (ids.length === 1) {
    return {
      success: true,
      data: {
        messageId: ids[0],
        ...(outcome.labelIds === undefined ? {} : { labelIds: outcome.labelIds }),
        modifiedCount: 1,
        message: singular,
      },
    };
  }

  return {
    success: true,
    data: {
      messageIds: ids,
      modifiedCount: outcome.modifiedCount,
      message: plural(outcome.modifiedCount),
    },
  };
}

/**
 * Mark message(s) as read/unread handler
 */
export async function handleMarkRead(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const gmail = getGmailClient(context);

  const ids = resolveMessageIds(args);
  if (!Array.isArray(ids)) return { success: false, error: ids.error };

  const unread = args.unread as boolean | undefined;

  // Mark as read = remove UNREAD label. Mark as unread = add UNREAD label.
  const addLabelIds = unread ? ['UNREAD'] : [];
  const removeLabelIds = unread ? [] : ['UNREAD'];

  const outcome = await applyLabelChange(gmail, ids, addLabelIds, removeLabelIds);

  return labelChangeResult(
    ids,
    outcome,
    unread ? 'Message marked as unread' : 'Message marked as read',
    (n) => `${n} messages marked as ${unread ? 'unread' : 'read'}`
  );
}

/**
 * Archive message(s) handler
 */
export async function handleArchive(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const gmail = getGmailClient(context);

  const ids = resolveMessageIds(args);
  if (!Array.isArray(ids)) return { success: false, error: ids.error };

  const outcome = await applyLabelChange(gmail, ids, [], ['INBOX']);

  return labelChangeResult(
    ids,
    outcome,
    'Message archived (removed from inbox)',
    (n) => `${n} messages archived (removed from inbox)`
  );
}

/**
 * Modify message labels handler
 */
export async function handleModifyLabels(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const gmail = getGmailClient(context);

  const ids = resolveMessageIds(args);
  if (!Array.isArray(ids)) return { success: false, error: ids.error };

  const addLabelIds = (args.addLabelIds as string[]) ?? [];
  const removeLabelIds = (args.removeLabelIds as string[]) ?? [];

  const outcome = await applyLabelChange(gmail, ids, addLabelIds, removeLabelIds);

  return labelChangeResult(
    ids,
    outcome,
    'Message labels updated',
    (n) => `Labels updated on ${n} messages`
  );
}

/**
 * List labels handler
 */
export async function handleListLabels(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const gmail = getGmailClient(context);

  const response = await gmail.users.labels.list({
    userId: 'me',
  });

  const labels = (response.data.labels ?? []).map((label) => ({
    id: label.id,
    name: label.name,
    type: label.type,
    messageListVisibility: label.messageListVisibility,
    labelListVisibility: label.labelListVisibility,
  }));

  return {
    success: true,
    data: { labels },
  };
}

/**
 * Create label handler
 */
export async function handleCreateLabel(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const gmail = getGmailClient(context);

  const name = args.name as string;
  const messageListVisibility = (args.messageListVisibility as string) ?? 'show';
  const labelListVisibility = (args.labelListVisibility as string) ?? 'labelShow';

  const response = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name,
      messageListVisibility: messageListVisibility as 'hide' | 'show',
      labelListVisibility: labelListVisibility as 'labelHide' | 'labelShow' | 'labelShowIfUnread',
    },
  });

  return {
    success: true,
    data: {
      id: response.data.id,
      name: response.data.name,
      type: response.data.type,
      messageListVisibility: response.data.messageListVisibility,
      labelListVisibility: response.data.labelListVisibility,
      message: `Label "${name}" created successfully`,
    },
  };
}

/**
 * Delete label handler
 */
export async function handleDeleteLabel(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const gmail = getGmailClient(context);

  const labelId = args.labelId as string;

  await gmail.users.labels.delete({
    userId: 'me',
    id: labelId,
  });

  return {
    success: true,
    data: {
      labelId,
      message: 'Label deleted successfully',
    },
  };
}

/**
 * Apply a label to a message handler
 */
export async function handleLabelMessage(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const gmail = getGmailClient(context);

  const ids = resolveMessageIds(args);
  if (!Array.isArray(ids)) return { success: false, error: ids.error };

  const labelId = args.labelId as string;

  const outcome = await applyLabelChange(gmail, ids, [labelId], []);

  return labelChangeResult(
    ids,
    outcome,
    `Label ${labelId} applied to message`,
    (n) => `Label ${labelId} applied to ${n} messages`
  );
}
