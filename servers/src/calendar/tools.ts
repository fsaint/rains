/**
 * Google Calendar MCP Server Tool Definitions
 */

import type { ToolDefinition } from '../common/base-server.js';
import {
  handleListEvents,
  handleGetEvent,
  handleSearchEvents,
  handleCreateEvent,
  handleUpdateEvent,
  handleDeleteEvent,
  handleListCalendars,
  handleGetFreeBusy,
} from './handlers.js';

/**
 * List upcoming events
 */
export const listEventsTool: ToolDefinition = {
  name: 'calendar_list_events',
  description:
    'List upcoming events from Google Calendar. Returns event details including time, location, and attendees.',
  inputSchema: {
    type: 'object',
    properties: {
      calendarId: {
        type: 'string',
        description: 'Calendar ID (default: "primary" for main calendar)',
      },
      timeMin: {
        type: 'string',
        description: 'Start time in ISO 8601 format (default: now)',
      },
      timeMax: {
        type: 'string',
        description: 'End time in ISO 8601 format',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum events to return (default: 10, max: 250)',
      },
      singleEvents: {
        type: 'boolean',
        description: 'Expand recurring events (default: true)',
      },
      orderBy: {
        type: 'string',
        enum: ['startTime', 'updated'],
        description: 'Sort order (default: startTime)',
      },
      pageToken: {
        type: 'string',
        description: 'Token for pagination',
      },
    },
  },
  handler: handleListEvents,
};

/**
 * Get event details
 */
export const getEventTool: ToolDefinition = {
  name: 'calendar_get_event',
  description: 'Get detailed information about a specific calendar event.',
  inputSchema: {
    type: 'object',
    properties: {
      calendarId: {
        type: 'string',
        description: 'Calendar ID (default: "primary")',
      },
      eventId: {
        type: 'string',
        description: 'The ID of the event',
      },
    },
    required: ['eventId'],
  },
  handler: handleGetEvent,
};

/**
 * Search events
 */
export const searchEventsTool: ToolDefinition = {
  name: 'calendar_search_events',
  description: 'Search for events by text query across all calendars.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Text to search for in event summaries, descriptions, and locations',
      },
      calendarId: {
        type: 'string',
        description: 'Calendar ID to search (default: "primary")',
      },
      timeMin: {
        type: 'string',
        description: 'Start of search range in ISO 8601 format',
      },
      timeMax: {
        type: 'string',
        description: 'End of search range in ISO 8601 format',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum results (default: 20)',
      },
    },
    required: ['query'],
  },
  handler: handleSearchEvents,
};

/**
 * Create an event
 */
export const createEventTool: ToolDefinition = {
  name: 'calendar_create_event',
  description: 'Create a new calendar event.',
  inputSchema: {
    type: 'object',
    properties: {
      calendarId: {
        type: 'string',
        description: 'Calendar ID (default: "primary")',
      },
      summary: {
        type: 'string',
        description: 'Event title',
      },
      description: {
        type: 'string',
        description: 'Event description',
      },
      location: {
        type: 'string',
        description: 'Event location',
      },
      startTime: {
        type: 'string',
        description: 'Start time in ISO 8601 format (e.g., "2024-03-20T10:00:00-08:00")',
      },
      endTime: {
        type: 'string',
        description: 'End time in ISO 8601 format',
      },
      allDay: {
        type: 'boolean',
        description: 'Create as all-day event',
      },
      startDate: {
        type: 'string',
        description: 'Start date for all-day event (YYYY-MM-DD)',
      },
      endDate: {
        type: 'string',
        description: 'End date for all-day event (YYYY-MM-DD)',
      },
      attendees: {
        type: 'array',
        items: { type: 'string' },
        description: 'Email addresses of attendees',
      },
      recurrence: {
        type: 'array',
        items: { type: 'string' },
        description: 'RRULE strings for recurring events',
      },
      reminders: {
        type: 'object',
        properties: {
          useDefault: { type: 'boolean' },
          overrides: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                method: { type: 'string', enum: ['email', 'popup'] },
                minutes: { type: 'number' },
              },
            },
          },
        },
        description: 'Reminder settings',
      },
      conferenceData: {
        type: 'boolean',
        description: 'Add Google Meet link',
      },
      sendUpdates: {
        type: 'string',
        enum: ['all', 'externalOnly', 'none'],
        description: 'Send notifications to attendees (default: "all")',
      },
    },
    required: ['summary'],
  },
  handler: handleCreateEvent,
};

/**
 * Update an event
 */
export const updateEventTool: ToolDefinition = {
  name: 'calendar_update_event',
  description: 'Update an existing calendar event.',
  inputSchema: {
    type: 'object',
    properties: {
      calendarId: {
        type: 'string',
        description: 'Calendar ID (default: "primary")',
      },
      eventId: {
        type: 'string',
        description: 'The ID of the event to update',
      },
      summary: {
        type: 'string',
        description: 'New event title',
      },
      description: {
        type: 'string',
        description: 'New event description',
      },
      location: {
        type: 'string',
        description: 'New event location',
      },
      startTime: {
        type: 'string',
        description: 'New start time in ISO 8601 format',
      },
      endTime: {
        type: 'string',
        description: 'New end time in ISO 8601 format',
      },
      attendees: {
        type: 'array',
        items: { type: 'string' },
        description: 'Updated list of attendee emails',
      },
      sendUpdates: {
        type: 'string',
        enum: ['all', 'externalOnly', 'none'],
        description: 'Send notifications about changes',
      },
    },
    required: ['eventId'],
  },
  handler: handleUpdateEvent,
};

/**
 * Delete an event
 */
export const deleteEventTool: ToolDefinition = {
  name: 'calendar_delete_event',
  description: 'Delete a calendar event.',
  inputSchema: {
    type: 'object',
    properties: {
      calendarId: {
        type: 'string',
        description: 'Calendar ID (default: "primary")',
      },
      eventId: {
        type: 'string',
        description: 'The ID of the event to delete',
      },
      sendUpdates: {
        type: 'string',
        enum: ['all', 'externalOnly', 'none'],
        description: 'Send cancellation notifications',
      },
    },
    required: ['eventId'],
  },
  handler: handleDeleteEvent,
};

/**
 * List calendars
 */
export const listCalendarsTool: ToolDefinition = {
  name: 'calendar_list_calendars',
  description: 'List all calendars the user has access to.',
  inputSchema: {
    type: 'object',
    properties: {
      showHidden: {
        type: 'boolean',
        description: 'Include hidden calendars',
      },
      showDeleted: {
        type: 'boolean',
        description: 'Include deleted calendars',
      },
    },
  },
  handler: handleListCalendars,
};

/**
 * Get free/busy information
 */
export const getFreeBusyTool: ToolDefinition = {
  name: 'calendar_get_free_busy',
  description: 'Get free/busy information for calendars.',
  inputSchema: {
    type: 'object',
    properties: {
      timeMin: {
        type: 'string',
        description: 'Start of time range in ISO 8601 format',
      },
      timeMax: {
        type: 'string',
        description: 'End of time range in ISO 8601 format',
      },
      calendarIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Calendar IDs to check (default: ["primary"])',
      },
    },
    required: ['timeMin', 'timeMax'],
  },
  handler: handleGetFreeBusy,
};

/**
 * All Calendar tools
 */
export const calendarTools: ToolDefinition[] = [
  listEventsTool,
  getEventTool,
  searchEventsTool,
  createEventTool,
  updateEventTool,
  deleteEventTool,
  listCalendarsTool,
  getFreeBusyTool,
];
