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
  handleListProjectSessions,
  handleListInstanceSessions,
  handleListRoles,
  handleGetRole,
  handleSetRole,
  handleRemoveFromProject,
  handleUpdateProfile,
  handleSetCoachingNotes,
  pinnedProject,
} from './handlers.js';

export const listProjectsTool: ToolDefinition = {
  name: 'hermeneutix_list_projects',
  description:
    'List all active projects available to the authenticated user. When this agent is limited ' +
    'to one project, returns only that permitted project.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: handleListProjects,
};

export const listMeetingsTool: ToolDefinition = {
  name: 'hermeneutix_list_meetings',
  description:
    'List meetings (recurring meeting series) in a project, paginated. Returns up to `limit` ' +
    'meetings (default 25, max 100) starting at `offset`, with `total` and `has_more`. Set ' +
    'include_recent_instances=true to attach the last 5 instances per meeting — one extra ' +
    'request per meeting, so leave it off when you only need names and ids.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'The project ID to list meetings for. Omit when this agent is limited to one project; it is filled in.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of meetings to return (default 25, max 100)',
      },
      offset: {
        type: 'number',
        description: 'Number of meetings to skip for offset-based pagination',
      },
      include_recent_instances: {
        type: 'boolean',
        description: 'Attach recent_instances (last 5) to each meeting. Default false.',
      },
    },
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
        description: 'The project ID to list speakers for. Omit when this agent is limited to one project; it is filled in.',
      },
    },
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
        description: 'The project ID to search within. Omit when this agent is limited to one project; it is filled in.',
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
  },
  handler: handleSearchInstances,
};

export const listProjectSessionsTool: ToolDefinition = {
  name: 'hermeneutix_list_sessions',
  description:
    'List all sessions (conversation transcripts) in a project or for a specific meeting instance. ' +
    'Provide project_id to list all sessions across the project, or instance_id to list sessions for one instance. ' +
    'Use include="messages" to get full transcripts.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'List sessions in this project (use either project_id or instance_id). Omit when this agent is limited to one project; it is filled in.',
      },
      instance_id: {
        type: 'string',
        description: 'List sessions for this meeting instance (use either project_id or instance_id)',
      },
      include: {
        type: 'string',
        enum: ['messages'],
        description: 'Pass "messages" to include full transcripts in the response',
      },
      page: {
        type: 'number',
        description: 'Page number for project-level listing (default 1)',
      },
      page_size: {
        type: 'number',
        description: 'Results per page for project-level listing (default 50, max 200)',
      },
    },
  },
  handler: async (args, context) => {
    if (args.instance_id) return handleListInstanceSessions(args, context);
    if (args.project_id || pinnedProject(context)) return handleListProjectSessions(args, context);
    return { success: false, error: 'Either project_id or instance_id is required' };
  },
};


// ---------------------------------------------------------------------------
// Roles and profiles
// ---------------------------------------------------------------------------

export const listRolesTool: ToolDefinition = {
  name: 'hermeneutix_list_roles',
  description:
    "Every person's role in a project: their profile id and name, the short role label, what they " +
    'are responsible for, and the negative prompt. Start here when you need a profile_id, or to see ' +
    'who is on the project and what each of them does.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Project to list. Omit when this agent is pinned to one.' },
      page: { type: 'number', description: 'Page number (default 1).' },
      page_size: { type: 'number', description: 'Results per page.' },
    },
    required: [],
  },
  handler: handleListRoles,
};

export const getRoleTool: ToolDefinition = {
  name: 'hermeneutix_get_role',
  description:
    'The role one person holds in a project. Answers that they are not a member if they have no ' +
    'role there.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Project. Omit when this agent is pinned to one.' },
      profile_id: { type: 'string', description: 'Profile id, from hermeneutix_search_profiles or hermeneutix_list_roles.' },
    },
    required: ['profile_id'],
  },
  handler: handleGetRole,
};

export const setRoleTool: ToolDefinition = {
  name: 'hermeneutix_set_role',
  description:
    "Set what a person is responsible for on a project. Creates the role if they are not yet a " +
    'member, updates it if they are — use this to add someone as well as to change them.\n' +
    '\n' +
    'Send ONLY the fields you mean to change: a field you leave out is kept as it is. To clear a ' +
    'field, pass an empty string for it.\n' +
    '\n' +
    'Base what you write on what the meetings actually show. This edits a real person\'s record, ' +
    'so the account owner is asked to approve it first.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Project. Omit when this agent is pinned to one.' },
      profile_id: { type: 'string', description: 'Profile id, from hermeneutix_search_profiles or hermeneutix_list_roles.' },
      name: { type: 'string', description: "Short role label, e.g. 'Superintendent'. Max 100 characters." },
      role_description: { type: 'string', description: 'What this person is responsible for.' },
      negative_prompt: { type: 'string', description: 'What this person is NOT responsible for, to keep analysis from misattributing work to them.' },
    },
    required: ['profile_id'],
  },
  handler: handleSetRole,
};

export const removeFromProjectTool: ToolDefinition = {
  name: 'hermeneutix_remove_from_project',
  description:
    'Remove a person from a project, deleting their role on it. Their profile and their words in ' +
    'past meetings are untouched; they simply stop being a member. Requires approval.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Project. Omit when this agent is pinned to one.' },
      profile_id: { type: 'string', description: 'Profile id of the person to remove.' },
    },
    required: ['profile_id'],
  },
  handler: handleRemoveFromProject,
};

export const updateProfileTool: ToolDefinition = {
  name: 'hermeneutix_update_profile',
  description:
    "Correct a person's name or email. A profile is shared across every project it appears in, so " +
    'this changes them everywhere, not just on one project. Use it to fix a misspelling or a ' +
    'transcription artefact, not to record what someone does — that is hermeneutix_set_role.\n' +
    '\n' +
    'name is required and replaces the existing one. Requires approval.',
  inputSchema: {
    type: 'object',
    properties: {
      profile_id: { type: 'string', description: 'Profile id, from hermeneutix_search_profiles.' },
      name: { type: 'string', description: "The person's full name. Required; replaces the current name." },
      email: { type: 'string', description: 'Email address. Omit to leave it unchanged.' },
    },
    required: ['profile_id', 'name'],
  },
  handler: handleUpdateProfile,
};

export const setCoachingNotesTool: ToolDefinition = {
  name: 'hermeneutix_set_coaching_notes',
  description:
    "Replace a person's coaching notes — standing observations about how they work, of the kind " +
    'meetings reveal over time. This REPLACES the existing notes rather than appending, so read ' +
    'them first if you mean to build on them. Pass an empty string to clear. Requires approval.',
  inputSchema: {
    type: 'object',
    properties: {
      profile_id: { type: 'string', description: 'Profile id, from hermeneutix_search_profiles.' },
      coaching_notes: { type: 'string', description: 'The full notes text, replacing whatever is there.' },
    },
    required: ['profile_id', 'coaching_notes'],
  },
  handler: handleSetCoachingNotes,
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
  listProjectSessionsTool,
  listRolesTool,
  getRoleTool,
  setRoleTool,
  removeFromProjectTool,
  updateProfileTool,
  setCoachingNotesTool,
];
