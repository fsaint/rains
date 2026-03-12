/**
 * Gmail MCP Server Tool Handlers
 */

import { google, type gmail_v1 } from 'googleapis';
import type { ServerContext, ToolResult } from '../common/types.js';

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
 * Encode email to base64 URL-safe format
 */
function encodeEmail(email: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body?: string;
  htmlBody?: string;
  replyTo?: string;
}): string {
  const lines: string[] = [];

  lines.push(`To: ${email.to.join(', ')}`);
  if (email.cc?.length) {
    lines.push(`Cc: ${email.cc.join(', ')}`);
  }
  if (email.bcc?.length) {
    lines.push(`Bcc: ${email.bcc.join(', ')}`);
  }
  lines.push(`Subject: ${email.subject}`);

  if (email.replyTo) {
    lines.push(`In-Reply-To: ${email.replyTo}`);
    lines.push(`References: ${email.replyTo}`);
  }

  if (email.htmlBody) {
    lines.push('Content-Type: text/html; charset=utf-8');
    lines.push('');
    lines.push(email.htmlBody);
  } else {
    lines.push('Content-Type: text/plain; charset=utf-8');
    lines.push('');
    lines.push(email.body ?? '');
  }

  const raw = lines.join('\r\n');
  return Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
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

  // Extract attachment metadata
  const attachments: { filename: string; mimeType: string; size: number }[] = [];
  const extractAttachments = (part: gmail_v1.Schema$MessagePart) => {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        size: part.body.size ?? 0,
      });
    }
    if (part.parts) {
      part.parts.forEach(extractAttachments);
    }
  };
  if (message.payload) {
    extractAttachments(message.payload);
  }

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

  const raw = encodeEmail({ to, cc, bcc, subject, body, htmlBody, replyTo });

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

  const raw = encodeEmail({ to, cc, bcc, subject, body, htmlBody, replyTo });

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
