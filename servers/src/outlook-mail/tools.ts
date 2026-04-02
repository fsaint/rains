/**
 * Outlook Mail MCP Server Tool Definitions
 */

import type { ToolDefinition } from '../common/base-server.js';
import {
  handleGetProfile,
  handleListMessages,
  handleGetMessage,
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
  description: 'Get the full content of an email message including headers, body, and attachment info.',
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
  description: 'Create a draft email. The draft will be saved but not sent. Use outlook_mail_send_draft to send it.',
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
  getProfileTool,
  listMessagesTool,
  getMessageTool,
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
