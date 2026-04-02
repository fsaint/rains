/**
 * Outlook Calendar MCP Server Tool Definitions
 */

import type { ToolDefinition } from '../common/base-server.js';
import {
  handleListCalendars,
  handleListEvents,
  handleGetEvent,
  handleSearchEvents,
  handleCreateEvent,
  handleUpdateEvent,
  handleDeleteEvent,
  handleRespondToEvent,
  handleGetFreeBusy,
} from './handlers.js';

// ============================================================================
// Read tools
// ============================================================================

export const listCalendarsTool: ToolDefinition = {
  name: 'outlook_cal_list_calendars',
  description: 'List all calendars for the authenticated user.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: handleListCalendars,
};

export const listEventsTool: ToolDefinition = {
  name: 'outlook_cal_list_events',
  description: 'List calendar events with optional date range filtering.',
  inputSchema: {
    type: 'object',
    properties: {
      calendarId: {
        type: 'string',
        description: 'Calendar ID. Omit for default calendar.',
      },
      startDateTime: {
        type: 'string',
        description: 'Start of date range (ISO 8601, e.g., "2026-03-31T00:00:00")',
      },
      endDateTime: {
        type: 'string',
        description: 'End of date range (ISO 8601)',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum events to return (default: 10, max: 100)',
      },
    },
  },
  handler: handleListEvents,
};

export const getEventTool: ToolDefinition = {
  name: 'outlook_cal_get_event',
  description: 'Get detailed information about a specific calendar event including body and attendees.',
  inputSchema: {
    type: 'object',
    properties: {
      eventId: {
        type: 'string',
        description: 'The ID of the event to retrieve',
      },
    },
    required: ['eventId'],
  },
  handler: handleGetEvent,
};

export const searchEventsTool: ToolDefinition = {
  name: 'outlook_cal_search_events',
  description: 'Search calendar events by keyword.',
  inputSchema: {
    type: 'object',
    properties: {
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
  handler: handleSearchEvents,
};

export const getFreeBusyTool: ToolDefinition = {
  name: 'outlook_cal_get_free_busy',
  description: 'Check free/busy availability for one or more users.',
  inputSchema: {
    type: 'object',
    properties: {
      schedules: {
        type: 'array',
        items: { type: 'string' },
        description: 'Email addresses to check availability for',
      },
      startDateTime: {
        type: 'string',
        description: 'Start of time range (ISO 8601)',
      },
      endDateTime: {
        type: 'string',
        description: 'End of time range (ISO 8601)',
      },
      timeZone: {
        type: 'string',
        description: 'Time zone (default: UTC)',
      },
      intervalMinutes: {
        type: 'number',
        description: 'Availability interval in minutes (default: 30)',
      },
    },
    required: ['schedules', 'startDateTime', 'endDateTime'],
  },
  handler: handleGetFreeBusy,
};

// ============================================================================
// Write tools
// ============================================================================

export const createEventTool: ToolDefinition = {
  name: 'outlook_cal_create_event',
  description: 'Create a new calendar event.',
  inputSchema: {
    type: 'object',
    properties: {
      calendarId: {
        type: 'string',
        description: 'Calendar ID. Omit for default calendar.',
      },
      subject: {
        type: 'string',
        description: 'Event title/subject',
      },
      startDateTime: {
        type: 'string',
        description: 'Start date and time (ISO 8601, e.g., "2026-03-31T09:00:00")',
      },
      endDateTime: {
        type: 'string',
        description: 'End date and time (ISO 8601)',
      },
      timeZone: {
        type: 'string',
        description: 'Time zone (e.g., "America/New_York"). Default: UTC',
      },
      body: {
        type: 'string',
        description: 'Event description (plain text)',
      },
      htmlBody: {
        type: 'string',
        description: 'Event description (HTML)',
      },
      location: {
        type: 'string',
        description: 'Event location',
      },
      attendees: {
        type: 'array',
        items: { type: 'string' },
        description: 'Attendee email addresses',
      },
      isAllDay: {
        type: 'boolean',
        description: 'Whether this is an all-day event',
      },
      isOnlineMeeting: {
        type: 'boolean',
        description: 'Create a Teams online meeting link',
      },
      recurrence: {
        type: 'object',
        description: 'Recurrence pattern (Microsoft Graph recurrence object)',
      },
    },
    required: ['subject', 'startDateTime', 'endDateTime'],
  },
  handler: handleCreateEvent,
};

export const updateEventTool: ToolDefinition = {
  name: 'outlook_cal_update_event',
  description: 'Update an existing calendar event. Only provided fields will be changed.',
  inputSchema: {
    type: 'object',
    properties: {
      eventId: {
        type: 'string',
        description: 'The ID of the event to update',
      },
      subject: {
        type: 'string',
        description: 'New event title',
      },
      startDateTime: {
        type: 'string',
        description: 'New start date and time (ISO 8601)',
      },
      endDateTime: {
        type: 'string',
        description: 'New end date and time (ISO 8601)',
      },
      timeZone: {
        type: 'string',
        description: 'Time zone for start/end times',
      },
      body: {
        type: 'string',
        description: 'New event description',
      },
      location: {
        type: 'string',
        description: 'New event location',
      },
      attendees: {
        type: 'array',
        items: { type: 'string' },
        description: 'Updated attendee email addresses',
      },
    },
    required: ['eventId'],
  },
  handler: handleUpdateEvent,
};

export const respondToEventTool: ToolDefinition = {
  name: 'outlook_cal_respond_to_event',
  description: 'Accept, tentatively accept, or decline a calendar event invitation.',
  inputSchema: {
    type: 'object',
    properties: {
      eventId: {
        type: 'string',
        description: 'The ID of the event to respond to',
      },
      response: {
        type: 'string',
        enum: ['accept', 'tentativelyAccept', 'decline'],
        description: 'Response type',
      },
      comment: {
        type: 'string',
        description: 'Optional message to include with the response',
      },
    },
    required: ['eventId', 'response'],
  },
  handler: handleRespondToEvent,
};

// ============================================================================
// Blocked tools
// ============================================================================

export const deleteEventTool: ToolDefinition = {
  name: 'outlook_cal_delete_event',
  description: 'Delete a calendar event. This cannot be undone.',
  inputSchema: {
    type: 'object',
    properties: {
      eventId: {
        type: 'string',
        description: 'The ID of the event to delete',
      },
    },
    required: ['eventId'],
  },
  handler: handleDeleteEvent,
};

// ============================================================================
// Export all tools
// ============================================================================

export const outlookCalendarTools: ToolDefinition[] = [
  // Read
  listCalendarsTool,
  listEventsTool,
  getEventTool,
  searchEventsTool,
  getFreeBusyTool,
  // Write
  createEventTool,
  updateEventTool,
  respondToEventTool,
  // Blocked by default
  deleteEventTool,
];
