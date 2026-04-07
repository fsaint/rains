/**
 * Hermeneutix MCP Server Tool Definitions
 */

import type { ToolDefinition } from '../common/base-server.js';
import {
  handleListProjects,
  handleListMeetings,
  handleListMeetingInstances,
  handleGetMeetingInstance,
  handleListSpeakers,
  handleGetConversationPreview,
  handleSearchProfiles,
  handleSearchInstances,
} from './handlers.js';

export const listProjectsTool: ToolDefinition = {
  name: 'hermeneutix_list_projects',
  description: 'List all active projects available to the authenticated user.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: handleListProjects,
};

export const listMeetingsTool: ToolDefinition = {
  name: 'hermeneutix_list_meetings',
  description:
    'List all meetings (recurring meeting series) in a project. Each meeting includes a recent_instances array with the last 5 instance IDs for quick lookback without an extra call.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'The project ID to list meetings for',
      },
    },
    required: ['project_id'],
  },
  handler: handleListMeetings,
};

export const listMeetingInstancesTool: ToolDefinition = {
  name: 'hermeneutix_list_meeting_instances',
  description:
    'List all instances (occurrences) of a recurring meeting. Returns id, sequence_number, scheduled_time, status, duration_seconds, message_count, and session_count for each. Supports pagination and sort order.',
  inputSchema: {
    type: 'object',
    properties: {
      meeting_id: {
        type: 'string',
        description: 'The meeting (series) ID to list instances for',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of instances to return (default: 20)',
      },
      offset: {
        type: 'number',
        description: 'Number of instances to skip for offset-based pagination',
      },
      before: {
        type: 'string',
        description: 'Return instances before this instance ID (cursor-based pagination)',
      },
      after: {
        type: 'string',
        description: 'Return instances after this instance ID (cursor-based pagination)',
      },
      sort_order: {
        type: 'string',
        enum: ['asc', 'desc'],
        description: 'Sort order by scheduled_time. Defaults to desc (newest first)',
      },
    },
    required: ['meeting_id'],
  },
  handler: handleListMeetingInstances,
};

export const getMeetingInstanceTool: ToolDefinition = {
  name: 'hermeneutix_get_meeting_instance',
  description:
    'Get full detail for a meeting instance including sessions, transcriptions, and speaker assignments. Response includes previous_instance_id and next_instance_id for sequential traversal through history.',
  inputSchema: {
    type: 'object',
    properties: {
      instance_id: {
        type: 'string',
        description: 'The meeting instance ID',
      },
    },
    required: ['instance_id'],
  },
  handler: handleGetMeetingInstance,
};

export const listSpeakersTool: ToolDefinition = {
  name: 'hermeneutix_list_speakers',
  description: 'List project members available for speaker identification and assignment.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'The project ID to list speakers for',
      },
    },
    required: ['project_id'],
  },
  handler: handleListSpeakers,
};

export const getConversationPreviewTool: ToolDefinition = {
  name: 'hermeneutix_get_conversation_preview',
  description:
    'Retrieve a conversation transcript with speaker labels. By default returns the full transcript. Use max_messages to cap the result (e.g. 10 for a quick preview). The full transcript is also embedded in get_meeting_instance sessions.',
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: {
        type: 'string',
        description: 'The conversation ID to retrieve',
      },
      max_messages: {
        type: 'number',
        description: 'Maximum number of messages to return. Omit for full transcript.',
      },
    },
    required: ['conversation_id'],
  },
  handler: handleGetConversationPreview,
};

export const searchProfilesTool: ToolDefinition = {
  name: 'hermeneutix_search_profiles',
  description: 'Search speaker profiles by name or email for speaker assignment.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query string (name or email)',
      },
    },
  },
  handler: handleSearchProfiles,
};

export const searchInstancesTool: ToolDefinition = {
  name: 'hermeneutix_search_instances',
  description:
    'Search across all meeting instances in a project by keyword, date range, or topic. Useful for finding relevant sessions without fetching every instance.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'The project ID to search within',
      },
      q: {
        type: 'string',
        description: 'Keyword or topic query',
      },
      date_from: {
        type: 'string',
        description: 'Start date filter in ISO 8601 format (e.g. 2026-01-01)',
      },
      date_to: {
        type: 'string',
        description: 'End date filter in ISO 8601 format (e.g. 2026-04-06)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return',
      },
      offset: {
        type: 'number',
        description: 'Number of results to skip for pagination',
      },
    },
    required: ['project_id'],
  },
  handler: handleSearchInstances,
};

export const hermeneutixTools: ToolDefinition[] = [
  listProjectsTool,
  listMeetingsTool,
  listMeetingInstancesTool,
  getMeetingInstanceTool,
  listSpeakersTool,
  getConversationPreviewTool,
  searchProfilesTool,
  searchInstancesTool,
];
