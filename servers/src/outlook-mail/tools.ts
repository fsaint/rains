/**
 * Outlook Mail MCP Server Tool Definitions
 */

import type { ToolDefinition } from '../common/base-server.js';
import { createUploadLinkTool } from '../common/upload-link.js';
import { outlookAttachmentsSchema } from './attachment-schema.js';
import {
  handleGetProfile,
  handleListMessages,
  handleGetMessage,
  handleGetAttachment,
  handleSearchMessages,
  handleCreateDraft,
  handleSendDraft,
  handleSendMessage,
  handleReplyToMessage,
  handleDeleteMessage,
  handleMoveMessage,
  handleListFolders,
} from './handlers.js';

const accountProperty = {
  account: {
    type: 'string',
    description: 'Email of the account to use. Omit for default. See outlook_mail_get_profile.',
  },
} as const;

// ============================================================================
// Read tools
// ============================================================================

export const getProfileTool: ToolDefinition = {
  name: 'outlook_mail_get_profile',
  description: 'Get the authenticated Outlook user profile (display name and email).',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: handleGetProfile,
};

export const listMessagesTool: ToolDefinition = {
  name: 'outlook_mail_list_messages',
  description: 'List email messages in a mail folder. Returns message IDs, subjects, and previews.',
  inputSchema: {
    type: 'object',
    properties: {
      ...accountProperty,
      folder: {
        type: 'string',
        description: 'Mail folder to list from: inbox, drafts, sentitems, deleteditems, junkemail (default: inbox)',
      },
      filter: {
        type: 'string',
        description: 'OData filter expression (e.g., "isRead eq false", "from/emailAddress/address eq \'user@example.com\'")',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of messages to return (default: 10, max: 100)',
      },
    },
  },
  handler: handleListMessages,
};

export const getMessageTool: ToolDefinition = {
  name: 'outlook_mail_get_message',
  description:
    'Get the full content of an email message including headers, body, and the name, type and ' +
    'size of each attachment. To download one, use outlook_mail_get_attachment. To forward an attachment, pass ' +
    '{"source":"outlook","messageId":"…","filename":"…"} in the attachments parameter of ' +
    'outlook_mail_create_draft — the bytes never pass through your context.',
  inputSchema: {
    type: 'object',
    properties: {
      ...accountProperty,
      messageId: {
        type: 'string',
        description: 'The ID of the message to retrieve',
      },
    },
    required: ['messageId'],
  },
  handler: handleGetMessage,
};

export const getAttachmentTool: ToolDefinition = {
  name: 'outlook_mail_get_attachment',
  description:
    'Download an attachment from an Outlook email. Use outlook_mail_get_message first to see ' +
    'what a message carries.\n' +
    '\n' +
    'Name the attachment with "filename" (or "attachmentId" from outlook_mail_get_message). ' +
    'If the message has exactly one attachment you may omit both and it is used.\n' +
    '\n' +
    'Returns an authenticated download link, NOT the file bytes, so a large attachment never ' +
    'enters your context. The response gives you: filename, mimeType, size, url, token, ' +
    'expiresAt, and curl — where curl is the complete command, already filled in:\n' +
    '\n' +
    '  curl -fsSL -H "Authorization: Bearer <token>" -o "<filename>" "<url>"\n' +
    '\n' +
    'Run that command to write the file to disk. The token authorises this one attachment on ' +
    'this one account, expires about 10 minutes after the call, and stops working if the owner ' +
    'detaches the account — so download promptly and call this tool again if it expires. If you ' +
    'cannot run shell commands, give the user the curl command or the url and token.\n' +
    '\n' +
    'Attachments under 256 KB also include the bytes inline as base64 in `data`, so small ' +
    'text files and thumbnails need no download step. Forwarded emails and calendar items ' +
    'attached to a message are not files and cannot be downloaded.\n' +
    '\n' +
    'DO NOT call this to forward or re-send a file. To attach a file from an existing email, ' +
    'pass {"source":"outlook","messageId":"…","filename":"…"} in the attachments parameter of ' +
    'outlook_mail_create_draft — Helm fetches the bytes server-side, so they never pass through ' +
    'your context.',
  inputSchema: {
    type: 'object',
    properties: {
      ...accountProperty,
      messageId: {
        type: 'string',
        description: 'The ID of the message containing the attachment',
      },
      filename: {
        type: 'string',
        description:
          'Name of the attachment, as shown by outlook_mail_get_message. Optional when the ' +
          'message has exactly one attachment.',
      },
      attachmentId: {
        type: 'string',
        description: 'Optional. The attachmentId shown by outlook_mail_get_message.',
      },
    },
    required: ['messageId'],
  },
  handler: handleGetAttachment,
};

export const searchMessagesTool: ToolDefinition = {
  name: 'outlook_mail_search',
  description: 'Search emails using keyword search across subject, body, and sender.',
  inputSchema: {
    type: 'object',
    properties: {
      ...accountProperty,
      query: {
        type: 'string',
        description: 'Search query string',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum results (default: 20, max: 100)',
      },
    },
    required: ['query'],
  },
  handler: handleSearchMessages,
};

export const listFoldersTool: ToolDefinition = {
  name: 'outlook_mail_list_folders',
  description: 'List all mail folders with message counts.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: handleListFolders,
};

// ============================================================================
// Write tools
// ============================================================================

export const createDraftTool: ToolDefinition = {
  name: 'outlook_mail_create_draft',
  description:
    'Create a draft email, optionally with attachments. The draft will be saved but not sent. ' +
    'Use outlook_mail_send_draft to send it. To attach a file from your machine, call ' +
    'outlook_mail_create_upload_link first and pass the upload id in "attachments".',
  inputSchema: {
    type: 'object',
    properties: {
      ...accountProperty,
      to: {
        type: 'array',
        items: { type: 'string' },
        description: 'Recipient email addresses',
      },
      cc: {
        type: 'array',
        items: { type: 'string' },
        description: 'CC email addresses',
      },
      bcc: {
        type: 'array',
        items: { type: 'string' },
        description: 'BCC email addresses',
      },
      subject: {
        type: 'string',
        description: 'Email subject',
      },
      body: {
        type: 'string',
        description: 'Email body (plain text)',
      },
      htmlBody: {
        type: 'string',
        description: 'Email body (HTML)',
      },
      attachments: outlookAttachmentsSchema,
    },
    required: ['to', 'subject'],
  },
  handler: handleCreateDraft,
};

export const sendDraftTool: ToolDefinition = {
  name: 'outlook_mail_send_draft',
  description: 'Send a previously created draft email.',
  inputSchema: {
    type: 'object',
    properties: {
      ...accountProperty,
      messageId: {
        type: 'string',
        description: 'The ID of the draft message to send',
      },
    },
    required: ['messageId'],
  },
  handler: handleSendDraft,
};

export const sendMessageTool: ToolDefinition = {
  name: 'outlook_mail_send_message',
  description: 'Send an email directly without creating a draft first. Use with caution.',
  inputSchema: {
    type: 'object',
    properties: {
      ...accountProperty,
      to: {
        type: 'array',
        items: { type: 'string' },
        description: 'Recipient email addresses',
      },
      cc: {
        type: 'array',
        items: { type: 'string' },
        description: 'CC email addresses',
      },
      bcc: {
        type: 'array',
        items: { type: 'string' },
        description: 'BCC email addresses',
      },
      subject: {
        type: 'string',
        description: 'Email subject',
      },
      body: {
        type: 'string',
        description: 'Email body (plain text)',
      },
      htmlBody: {
        type: 'string',
        description: 'Email body (HTML)',
      },
      attachments: outlookAttachmentsSchema,
    },
    required: ['to', 'subject'],
  },
  handler: handleSendMessage,
};

export const replyToMessageTool: ToolDefinition = {
  name: 'outlook_mail_reply',
  description: 'Reply to an email message.',
  inputSchema: {
    type: 'object',
    properties: {
      ...accountProperty,
      messageId: {
        type: 'string',
        description: 'The ID of the message to reply to',
      },
      body: {
        type: 'string',
        description: 'Reply body text',
      },
    },
    required: ['messageId', 'body'],
  },
  handler: handleReplyToMessage,
};

export const moveMessageTool: ToolDefinition = {
  name: 'outlook_mail_move_message',
  description: 'Move an email to a different folder.',
  inputSchema: {
    type: 'object',
    properties: {
      ...accountProperty,
      messageId: {
        type: 'string',
        description: 'The ID of the message to move',
      },
      destinationFolder: {
        type: 'string',
        description: 'Destination folder ID or well-known name (inbox, drafts, sentitems, deleteditems, junkemail, archive)',
      },
    },
    required: ['messageId', 'destinationFolder'],
  },
  handler: handleMoveMessage,
};

// ============================================================================
// Blocked tools
// ============================================================================

export const deleteMessageTool: ToolDefinition = {
  name: 'outlook_mail_delete_message',
  description: 'Permanently delete an email message. This cannot be undone.',
  inputSchema: {
    type: 'object',
    properties: {
      ...accountProperty,
      messageId: {
        type: 'string',
        description: 'The ID of the message to delete',
      },
    },
    required: ['messageId'],
  },
  handler: handleDeleteMessage,
};

// ============================================================================
// Export all tools
// ============================================================================

export const outlookMailTools: ToolDefinition[] = [
  // Read
  createUploadLinkTool('outlook_mail_'),
  getProfileTool,
  listMessagesTool,
  getMessageTool,
  getAttachmentTool,
  searchMessagesTool,
  listFoldersTool,
  // Write
  createDraftTool,
  sendDraftTool,
  replyToMessageTool,
  moveMessageTool,
  // Blocked by default
  sendMessageTool,
  deleteMessageTool,
];
