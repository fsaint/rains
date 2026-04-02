/**
 * Outlook Mail MCP Server Tool Handlers
 *
 * Uses the Microsoft Graph API with an OAuth2 access token.
 */

import type { ServerContext, ToolResult } from '../common/types.js';

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

export async function handleCreateDraft(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const toRecipients = (args.to as string[]).map((email) => ({
    emailAddress: { address: email },
  }));

  const body: any = {
    subject: args.subject,
    body: {
      contentType: args.htmlBody ? 'HTML' : 'Text',
      content: args.htmlBody || args.body || '',
    },
    toRecipients,
  };

  if (args.cc) {
    body.ccRecipients = (args.cc as string[]).map((email) => ({ emailAddress: { address: email } }));
  }
  if (args.bcc) {
    body.bccRecipients = (args.bcc as string[]).map((email) => ({ emailAddress: { address: email } }));
  }

  const response = await graphRequest(context, '/me/messages', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return { success: true, data: { id: data.id, subject: data.subject } };
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
  const toRecipients = (args.to as string[]).map((email) => ({
    emailAddress: { address: email },
  }));

  const message: any = {
    subject: args.subject,
    body: {
      contentType: args.htmlBody ? 'HTML' : 'Text',
      content: args.htmlBody || args.body || '',
    },
    toRecipients,
  };

  if (args.cc) {
    message.ccRecipients = (args.cc as string[]).map((email) => ({ emailAddress: { address: email } }));
  }
  if (args.bcc) {
    message.bccRecipients = (args.bcc as string[]).map((email) => ({ emailAddress: { address: email } }));
  }

  const response = await graphRequest(context, '/me/sendMail', {
    method: 'POST',
    body: JSON.stringify({ message, saveToSentItems: true }),
  });

  if (!response.ok && response.status !== 202) return handleError(response);

  return { success: true, data: { sent: true } };
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
