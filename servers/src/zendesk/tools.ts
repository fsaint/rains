/**
 * Zendesk MCP Server Tool Definitions
 */

import type { ToolDefinition } from '../common/base-server.js';
import {
  handleListTickets,
  handleGetTicket,
  handleSearchTickets,
  handleListTicketComments,
  handleCreateTicket,
  handleUpdateTicket,
} from './handlers.js';

export const listTicketsTool: ToolDefinition = {
  name: 'zendesk_list_tickets',
  description: 'List tickets in Zendesk. Defaults to recent open tickets. Filter by status and control pagination.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['new', 'open', 'pending', 'hold', 'solved', 'closed'],
        description: 'Filter by ticket status',
      },
      page: { type: 'number', description: 'Page number (default: 1)' },
      per_page: { type: 'number', description: 'Results per page (max 100, default 25)' },
      sort_by: {
        type: 'string',
        enum: ['created_at', 'updated_at', 'priority', 'status', 'ticket_type'],
        description: 'Sort field',
      },
      sort_order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction' },
    },
  },
  handler: handleListTickets,
};

export const getTicketTool: ToolDefinition = {
  name: 'zendesk_get_ticket',
  description: 'Get full details for a single Zendesk ticket by ID.',
  inputSchema: {
    type: 'object',
    properties: {
      ticket_id: { type: 'number', description: 'The ticket ID' },
    },
    required: ['ticket_id'],
  },
  handler: handleGetTicket,
};

export const searchTicketsTool: ToolDefinition = {
  name: 'zendesk_search_tickets',
  description: 'Search Zendesk tickets using search syntax. Examples: "status:open priority:high", "assignee:me created>2026-01-01", "tag:billing".',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Zendesk search query (type:ticket is prepended automatically)',
      },
      page: { type: 'number', description: 'Page number' },
      per_page: { type: 'number', description: 'Results per page (max 100)' },
      sort_by: {
        type: 'string',
        enum: ['created_at', 'updated_at', 'priority', 'status', 'ticket_type', 'relevance'],
        description: 'Sort field',
      },
      sort_order: { type: 'string', enum: ['asc', 'desc'] },
    },
    required: ['query'],
  },
  handler: handleSearchTickets,
};

export const listTicketCommentsTool: ToolDefinition = {
  name: 'zendesk_list_ticket_comments',
  description: 'List all comments (full conversation thread) for a ticket, including public replies and internal notes.',
  inputSchema: {
    type: 'object',
    properties: {
      ticket_id: { type: 'number', description: 'The ticket ID' },
    },
    required: ['ticket_id'],
  },
  handler: handleListTicketComments,
};

export const createTicketTool: ToolDefinition = {
  name: 'zendesk_create_ticket',
  description: 'Create a new Zendesk support ticket.',
  inputSchema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Ticket subject line' },
      body: { type: 'string', description: 'Initial ticket description / first comment' },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Ticket priority' },
      type: { type: 'string', enum: ['problem', 'incident', 'question', 'task'], description: 'Ticket type' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags to apply to the ticket',
      },
      requester_email: { type: 'string', description: 'Email of the requester (if not the authenticated user)' },
      requester_name: { type: 'string', description: 'Display name of the requester' },
      assignee_email: { type: 'string', description: 'Email of the agent to assign the ticket to' },
    },
    required: ['subject', 'body'],
  },
  handler: handleCreateTicket,
};

export const updateTicketTool: ToolDefinition = {
  name: 'zendesk_update_ticket',
  description: 'Update a ticket — change status, priority, assignee, add a comment, or update tags.',
  inputSchema: {
    type: 'object',
    properties: {
      ticket_id: { type: 'number', description: 'The ticket ID to update' },
      status: {
        type: 'string',
        enum: ['open', 'pending', 'hold', 'solved', 'closed'],
        description: 'New ticket status',
      },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
      assignee_email: { type: 'string', description: 'Email of agent to assign to' },
      subject: { type: 'string', description: 'Updated subject' },
      comment: { type: 'string', description: 'Add a comment to the ticket' },
      comment_public: {
        type: 'boolean',
        description: 'Whether the comment is public (visible to requester). Defaults to true.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Replace all tags with this list',
      },
    },
    required: ['ticket_id'],
  },
  handler: handleUpdateTicket,
};

export const zendeskTools: ToolDefinition[] = [
  listTicketsTool,
  getTicketTool,
  searchTicketsTool,
  listTicketCommentsTool,
  createTicketTool,
  updateTicketTool,
];
