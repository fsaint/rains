import type { ToolDefinition } from '../common/base-server.js';
import {
  handleEcho,
  handleListItems,
  handleGetItem,
  handleCreateItem,
  handleSendMessage,
  handleUpdateItem,
  handleDeleteItem,
  handleWipeAll,
} from './handlers.js';

// ── Read (always allow) ────────────────────────────────────────────────────

export const sandboxEchoTool: ToolDefinition = {
  name: 'sandbox_echo',
  description: 'Echo a message back. Always allowed. Use to verify the agent can call tools without approval.',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The message to echo back' },
    },
    required: ['message'],
  },
  handler: handleEcho,
};

export const sandboxListItemsTool: ToolDefinition = {
  name: 'sandbox_list_items',
  description: 'List sandbox items. Always allowed. Returns a set of fake records.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max items to return (default: 10, max: 50)' },
    },
  },
  handler: handleListItems,
};

export const sandboxGetItemTool: ToolDefinition = {
  name: 'sandbox_get_item',
  description: 'Get a single sandbox item by ID. Always allowed.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Item ID (e.g. "item-1", "item-2", "item-3")' },
    },
    required: ['id'],
  },
  handler: handleGetItem,
};

// ── Write (require_approval) ───────────────────────────────────────────────

export const sandboxCreateItemTool: ToolDefinition = {
  name: 'sandbox_create_item',
  description: 'Create a new sandbox item. Requires approval. Use to test the approval → execute flow.',
  inputSchema: {
    type: 'object',
    properties: {
      name:  { type: 'string', description: 'Item name' },
      value: { type: 'string', description: 'Item value/description' },
    },
    required: ['name'],
  },
  handler: handleCreateItem,
};

export const sandboxSendMessageTool: ToolDefinition = {
  name: 'sandbox_send_message',
  description: 'Send a fake message. Requires approval. Use to test the approval flow for message-sending actions.',
  inputSchema: {
    type: 'object',
    properties: {
      to:      { type: 'string', description: 'Recipient identifier' },
      subject: { type: 'string', description: 'Message subject' },
      body:    { type: 'string', description: 'Message body' },
    },
    required: ['to', 'subject'],
  },
  handler: handleSendMessage,
};

export const sandboxUpdateItemTool: ToolDefinition = {
  name: 'sandbox_update_item',
  description: 'Update a sandbox item. Requires approval.',
  inputSchema: {
    type: 'object',
    properties: {
      id:    { type: 'string', description: 'Item ID to update' },
      name:  { type: 'string', description: 'New name (optional)' },
      value: { type: 'string', description: 'New value (optional)' },
    },
    required: ['id'],
  },
  handler: handleUpdateItem,
};

// ── Blocked (always denied) ────────────────────────────────────────────────

export const sandboxDeleteItemTool: ToolDefinition = {
  name: 'sandbox_delete_item',
  description: 'Delete a sandbox item. Blocked by default policy — use to verify that blocked tools are denied.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Item ID to delete' },
    },
    required: ['id'],
  },
  handler: handleDeleteItem,
};

export const sandboxWipeAllTool: ToolDefinition = {
  name: 'sandbox_wipe_all',
  description: 'Wipe all sandbox items. Blocked by default policy.',
  inputSchema: {
    type: 'object',
    properties: {
      confirm: { type: 'boolean', description: 'Must be true to proceed' },
    },
    required: ['confirm'],
  },
  handler: handleWipeAll,
};

export const devSandboxTools: ToolDefinition[] = [
  sandboxEchoTool,
  sandboxListItemsTool,
  sandboxGetItemTool,
  sandboxCreateItemTool,
  sandboxSendMessageTool,
  sandboxUpdateItemTool,
  sandboxDeleteItemTool,
  sandboxWipeAllTool,
];
