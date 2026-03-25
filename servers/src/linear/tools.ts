/**
 * Linear MCP Server Tool Definitions
 */

import type { ToolDefinition } from '../common/base-server.js';
import {
  handleListWorkspaces,
  handleListIssues,
  handleGetIssue,
  handleSearchIssues,
  handleListTeams,
  handleListProjects,
  handleGetProject,
  handleListCycles,
  handleListLabels,
  handleCreateIssue,
  handleUpdateIssue,
  handleCommentOnIssue,
  handleDeleteIssue,
} from './handlers.js';

/**
 * Common workspace property for multi-workspace support
 */
const workspaceProperty = {
  workspace: {
    type: 'string',
    description: 'Workspace name to use. Omit for default. See linear_list_workspaces.',
  },
} as const;

export const listWorkspacesTool: ToolDefinition = {
  name: 'linear_list_workspaces',
  description:
    'List all Linear workspaces connected to this agent. Use the workspace name from the response as the "workspace" parameter in other Linear tools to target a specific workspace.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: handleListWorkspaces,
};

export const listIssuesTool: ToolDefinition = {
  name: 'linear_list_issues',
  description: 'List issues with optional filters by team, project, assignee, or state type.',
  inputSchema: {
    type: 'object',
    properties: {
      ...workspaceProperty,
      teamId: { type: 'string', description: 'Filter by team ID' },
      projectId: { type: 'string', description: 'Filter by project ID' },
      assigneeId: { type: 'string', description: 'Filter by assignee ID' },
      stateType: {
        type: 'string',
        enum: ['backlog', 'unstarted', 'started', 'completed', 'cancelled'],
        description: 'Filter by state type',
      },
      limit: { type: 'number', description: 'Max results (default: 25, max: 50)' },
      cursor: { type: 'string', description: 'Pagination cursor' },
    },
  },
  handler: handleListIssues,
};

export const getIssueTool: ToolDefinition = {
  name: 'linear_get_issue',
  description:
    'Get full details of an issue including description, comments, relations, and sub-issues. Accepts an issue ID or identifier like "ENG-123".',
  inputSchema: {
    type: 'object',
    properties: {
      ...workspaceProperty,
      issueId: { type: 'string', description: 'Issue ID or identifier (e.g. "ENG-123")' },
    },
    required: ['issueId'],
  },
  handler: handleGetIssue,
};

export const searchIssuesTool: ToolDefinition = {
  name: 'linear_search_issues',
  description: 'Search issues by text query across titles, descriptions, and comments.',
  inputSchema: {
    type: 'object',
    properties: {
      ...workspaceProperty,
      query: { type: 'string', description: 'Search query text' },
      limit: { type: 'number', description: 'Max results (default: 20, max: 50)' },
    },
    required: ['query'],
  },
  handler: handleSearchIssues,
};

export const listTeamsTool: ToolDefinition = {
  name: 'linear_list_teams',
  description: 'List all teams in the workspace with their members.',
  inputSchema: {
    type: 'object',
    properties: {
      ...workspaceProperty,
    },
  },
  handler: handleListTeams,
};

export const listProjectsTool: ToolDefinition = {
  name: 'linear_list_projects',
  description: 'List projects in the workspace with status, progress, and dates.',
  inputSchema: {
    type: 'object',
    properties: {
      ...workspaceProperty,
      limit: { type: 'number', description: 'Max results (default: 25, max: 50)' },
    },
  },
  handler: handleListProjects,
};

export const getProjectTool: ToolDefinition = {
  name: 'linear_get_project',
  description: 'Get full details of a project including members, teams, and issues.',
  inputSchema: {
    type: 'object',
    properties: {
      ...workspaceProperty,
      projectId: { type: 'string', description: 'Project ID' },
    },
    required: ['projectId'],
  },
  handler: handleGetProject,
};

export const listCyclesTool: ToolDefinition = {
  name: 'linear_list_cycles',
  description: 'List cycles (sprints), optionally filtered by team.',
  inputSchema: {
    type: 'object',
    properties: {
      ...workspaceProperty,
      teamId: { type: 'string', description: 'Filter by team ID' },
    },
  },
  handler: handleListCycles,
};

export const listLabelsTool: ToolDefinition = {
  name: 'linear_list_labels',
  description: 'List all issue labels in the workspace.',
  inputSchema: {
    type: 'object',
    properties: {
      ...workspaceProperty,
    },
  },
  handler: handleListLabels,
};

export const createIssueTool: ToolDefinition = {
  name: 'linear_create_issue',
  description: 'Create a new issue in a team.',
  inputSchema: {
    type: 'object',
    properties: {
      ...workspaceProperty,
      teamId: { type: 'string', description: 'Team ID (required)' },
      title: { type: 'string', description: 'Issue title' },
      description: { type: 'string', description: 'Issue description (Markdown supported)' },
      priority: {
        type: 'number',
        enum: [0, 1, 2, 3, 4],
        description: 'Priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low',
      },
      assigneeId: { type: 'string', description: 'Assignee user ID' },
      stateId: { type: 'string', description: 'Workflow state ID' },
      projectId: { type: 'string', description: 'Project ID' },
      labelIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Label IDs to apply',
      },
      parentId: { type: 'string', description: 'Parent issue ID for sub-issues' },
      estimate: { type: 'number', description: 'Estimate points' },
    },
    required: ['teamId', 'title'],
  },
  handler: handleCreateIssue,
};

export const updateIssueTool: ToolDefinition = {
  name: 'linear_update_issue',
  description: 'Update an existing issue. Only provided fields will be changed.',
  inputSchema: {
    type: 'object',
    properties: {
      ...workspaceProperty,
      issueId: { type: 'string', description: 'Issue ID to update' },
      title: { type: 'string', description: 'New title' },
      description: { type: 'string', description: 'New description (Markdown)' },
      priority: {
        type: 'number',
        enum: [0, 1, 2, 3, 4],
        description: 'Priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low',
      },
      assigneeId: { type: 'string', description: 'New assignee user ID' },
      stateId: { type: 'string', description: 'New workflow state ID' },
      projectId: { type: 'string', description: 'New project ID' },
      labelIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Label IDs (replaces existing)',
      },
      estimate: { type: 'number', description: 'Estimate points' },
    },
    required: ['issueId'],
  },
  handler: handleUpdateIssue,
};

export const commentOnIssueTool: ToolDefinition = {
  name: 'linear_comment_on_issue',
  description: 'Add a comment to an issue.',
  inputSchema: {
    type: 'object',
    properties: {
      ...workspaceProperty,
      issueId: { type: 'string', description: 'Issue ID to comment on' },
      body: { type: 'string', description: 'Comment body (Markdown supported)' },
    },
    required: ['issueId', 'body'],
  },
  handler: handleCommentOnIssue,
};

export const deleteIssueTool: ToolDefinition = {
  name: 'linear_delete_issue',
  description: 'Permanently delete an issue. This cannot be undone.',
  inputSchema: {
    type: 'object',
    properties: {
      ...workspaceProperty,
      issueId: { type: 'string', description: 'Issue ID to delete' },
    },
    required: ['issueId'],
  },
  handler: handleDeleteIssue,
};

/**
 * All Linear tools
 */
export const linearTools: ToolDefinition[] = [
  listWorkspacesTool,
  listIssuesTool,
  getIssueTool,
  searchIssuesTool,
  listTeamsTool,
  listProjectsTool,
  getProjectTool,
  listCyclesTool,
  listLabelsTool,
  createIssueTool,
  updateIssueTool,
  commentOnIssueTool,
  deleteIssueTool,
];
