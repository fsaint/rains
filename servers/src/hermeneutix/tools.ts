/**
 * Hermeneutix MCP Server Tool Definitions
 */

import type { ToolDefinition } from '../common/base-server.js';
import {
  handleListProjects,
  handleListMeetings,
  handleGetMeetingInstance,
  handleListSpeakers,
  handleGetConversationPreview,
  handleSearchProfiles,
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
  description: 'List all meetings (recurring meeting series) in a project.',
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

export const getMeetingInstanceTool: ToolDefinition = {
  name: 'hermeneutix_get_meeting_instance',
  description:
    'Get full detail for a meeting instance including sessions, transcriptions, and speaker assignments.',
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
  description: 'Retrieve a preview of a conversation transcript (first 10 messages with speaker labels).',
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: {
        type: 'string',
        description: 'The conversation ID to preview',
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

export const hermeneutixTools: ToolDefinition[] = [
  listProjectsTool,
  listMeetingsTool,
  getMeetingInstanceTool,
  listSpeakersTool,
  getConversationPreviewTool,
  searchProfilesTool,
];
