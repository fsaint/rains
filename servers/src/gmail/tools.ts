/**
 * Gmail MCP Server Tool Definitions
 */

import type { ToolDefinition } from '../common/base-server.js';
import {
  handleListMessages,
  handleGetMessage,
  handleGetAttachment,
  handleSearch,
  handleCreateDraft,
  handleSendDraft,
  handleSendMessage,
  handleDeleteMessage,
  handleListLabels,
  handleListAccounts,
  handleMarkRead,
  handleArchive,
  handleModifyLabels,
} from './handlers.js';

/**
 * Common account property for multi-account support
 */
const accountProperty = {
  account: {
    type: 'string',
    description: 'Email of the account to use. Omit for default. See gmail_list_accounts.',
  },
} as const;

/**
 * List messages in the mailbox
 */
export const listMessagesTool: ToolDefinition = {
  name: 'gmail_list_messages',
  description:
    'List email messages in the mailbox. Returns message IDs and snippets. Use gmail_get_message to get full content.',
  inputSchema: {
    type: 'object',
    properties: {
      ...accountProperty,
      query: {
        type: 'string',
        description:
          'Gmail search query (e.g., "from:example@gmail.com", "is:unread", "subject:meeting")',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of messages to return (default: 10, max: 100)',
      },
      labelIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter by label IDs (e.g., ["INBOX", "UNREAD"])',
      },
      pageToken: {
        type: 'string',
        description: 'Token for pagination',
      },
    },
  },
  handler: handleListMessages,
};

/**
 * Get full message content
 */
export const getMessageTool: ToolDefinition = {
  name: 'gmail_get_message',
  description:
    'Get the full content of an email message including headers, body, and attachments metadata.',
  inputSchema: {
    type: 'object',
    properties: {
      ...accountProperty,
      messageId: {
        type: 'string',
        description: 'The ID of the message to retrieve',
      },
      format: {
        type: 'string',
        enum: ['minimal', 'full', 'raw', 'metadata'],
        description: 'Format of the message (default: full)',
      },
    },
    required: ['messageId'],
  },
  handler: handleGetMessage,
};

/**
 * Download an attachment
 */
export const getAttachmentTool: ToolDefinition = {
  name: 'gmail_get_attachment',
  description:
    'Download an email attachment by its attachment ID. Returns the attachment content as base64url-encoded data. Use gmail_get_message first to get attachment IDs.',
  inputSchema: {
    type: 'object',
    properties: {
      ...accountProperty,
      messageId: {
        type: 'string',
        description: 'The ID of the message containing the attachment',
      },
      attachmentId: {
        type: 'string',
        description: 'The attachment ID from gmail_get_message attachments list',
      },
    },
    required: ['messageId', 'attachmentId'],
  },
  handler: handleGetAttachment,
};

/**
 * Search messages with advanced query
 */
export const searchTool: ToolDefinition = {
  name: 'gmail_search',
  description:
    'Search emails using Gmail search operators. Returns matching messages with snippets.',
  inputSchema: {
    type: 'object',
    properties: {
      ...accountProperty,
      query: {
        type: 'string',
        description:
          'Gmail search query. Supports operators like: from:, to:, subject:, has:attachment, is:unread, after:, before:, newer_than:, older_than:',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum results (default: 20, max: 100)',
      },
      includeSpamTrash: {
        type: 'boolean',
        description: 'Include spam and trash in results',
      },
    },
    required: ['query'],
  },
  handler: handleSearch,
};

/**
 * Create a draft email
 */
export const createDraftTool: ToolDefinition = {
  name: 'gmail_create_draft',
  description:
    'Create a draft email. The draft will be saved but not sent. Use gmail_send_draft to send it.',
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
      replyTo: {
        type: 'string',
        description: 'Message ID to reply to',
      },
      threadId: {
        type: 'string',
        description: 'Thread ID to add the message to',
      },
    },
    required: ['to', 'subject'],
  },
  handler: handleCreateDraft,
};

/**
 * Send a draft email
 */
export const sendDraftTool: ToolDefinition = {
  name: 'gmail_send_draft',
  description: 'Send a previously created draft email.',
  inputSchema: {
    type: 'object',
    properties: {
      ...accountProperty,
      draftId: {
        type: 'string',
        description: 'The ID of the draft to send',
      },
    },
    required: ['draftId'],
  },
  handler: handleSendDraft,
};

/**
 * Send an email directly
 */
export const sendMessageTool: ToolDefinition = {
  name: 'gmail_send_message',
  description:
    'Send an email directly without creating a draft first. Use with caution.',
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
      replyTo: {
        type: 'string',
        description: 'Message ID to reply to',
      },
      threadId: {
        type: 'string',
        description: 'Thread ID to add the message to',
      },
    },
    required: ['to', 'subject'],
  },
  handler: handleSendMessage,
};

/**
 * Delete a message
 */
export const deleteMessageTool: ToolDefinition = {
  name: 'gmail_delete_message',
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

/**
 * List labels
 */
export const listLabelsTool: ToolDefinition = {
  name: 'gmail_list_labels',
  description: 'List all labels in the mailbox.',
  inputSchema: {
    type: 'object',
    properties: {
      ...accountProperty,
    },
  },
  handler: handleListLabels,
};

/**
 * List linked accounts
 */
export const listAccountsTool: ToolDefinition = {
  name: 'gmail_list_accounts',
  description:
    'List all Gmail accounts linked to this agent. Use the email from the response as the "account" parameter in other Gmail tools to target a specific account.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: handleListAccounts,
};

/**
 * Mark message as read or unread
 */
export const markReadTool: ToolDefinition = {
  name: 'gmail_mark_read',
  description: 'Mark an email as read or unread.',
  inputSchema: {
    type: 'object',
    properties: {
      ...accountProperty,
      messageId: {
        type: 'string',
        description: 'The ID of the message to mark',
      },
      unread: {
        type: 'boolean',
        description: 'Set to true to mark as unread, false (default) to mark as read',
      },
    },
    required: ['messageId'],
  },
  handler: handleMarkRead,
};

/**
 * Archive a message (remove from inbox)
 */
export const archiveTool: ToolDefinition = {
  name: 'gmail_archive',
  description: 'Archive an email by removing it from the inbox. The message is not deleted.',
  inputSchema: {
    type: 'object',
    properties: {
      ...accountProperty,
      messageId: {
        type: 'string',
        description: 'The ID of the message to archive',
      },
    },
    required: ['messageId'],
  },
  handler: handleArchive,
};

/**
 * Add or remove labels on a message
 */
export const modifyLabelsTool: ToolDefinition = {
  name: 'gmail_modify_labels',
  description: 'Add or remove labels on an email. Use gmail_list_labels to get available label IDs.',
  inputSchema: {
    type: 'object',
    properties: {
      ...accountProperty,
      messageId: {
        type: 'string',
        description: 'The ID of the message to modify',
      },
      addLabelIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Label IDs to add (e.g., ["STARRED", "Label_123"])',
      },
      removeLabelIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Label IDs to remove (e.g., ["UNREAD", "INBOX"])',
      },
    },
    required: ['messageId'],
  },
  handler: handleModifyLabels,
};

/**
 * All Gmail tools
 */
export const gmailTools: ToolDefinition[] = [
  listAccountsTool,
  listMessagesTool,
  getMessageTool,
  getAttachmentTool,
  searchTool,
  createDraftTool,
  sendDraftTool,
  sendMessageTool,
  deleteMessageTool,
  listLabelsTool,
  markReadTool,
  archiveTool,
  modifyLabelsTool,
];
