/**
 * GitHub MCP Server Tool Definitions
 *
 * Each tool declares its required GitHub scope.
 */

import type { ToolDefinition } from '../common/base-server.js';
import {
  handleListRepos,
  handleGetRepo,
  handleListIssues,
  handleGetIssue,
  handleCreateIssue,
  handleCommentOnIssue,
  handleListPullRequests,
  handleGetPullRequest,
  handleGetPullRequestDiff,
  handleGetFileContent,
  handleSearchCode,
  handleGetUser,
} from './handlers.js';

// ============================================================================
// Read tools (repo scope or public access)
// ============================================================================

export const listReposTool: ToolDefinition = {
  name: 'github_list_repos',
  description: 'List repositories for the authenticated user. Returns name, description, language, and stars.',
  inputSchema: {
    type: 'object',
    properties: {
      sort: {
        type: 'string',
        description: 'Sort by: created, updated, pushed, full_name (default: updated)',
      },
      type: {
        type: 'string',
        description: 'Filter by type: all, owner, public, private, member (default: all)',
      },
      perPage: { type: 'number', description: 'Results per page (default: 30, max: 100)' },
      page: { type: 'number', description: 'Page number (default: 1)' },
    },
  },
  handler: handleListRepos,
};

export const getRepoTool: ToolDefinition = {
  name: 'github_get_repo',
  description: 'Get detailed information about a specific repository.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or org)' },
      repo: { type: 'string', description: 'Repository name' },
    },
    required: ['owner', 'repo'],
  },
  handler: handleGetRepo,
};

export const listIssuesTool: ToolDefinition = {
  name: 'github_list_issues',
  description: 'List issues in a repository. Includes pull requests unless filtered.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', description: 'Filter by state: open, closed, all (default: open)' },
      labels: { type: 'string', description: 'Comma-separated list of label names' },
      perPage: { type: 'number', description: 'Results per page (default: 30, max: 100)' },
    },
    required: ['owner', 'repo'],
  },
  handler: handleListIssues,
};

export const getIssueTool: ToolDefinition = {
  name: 'github_get_issue',
  description: 'Get detailed information about a specific issue including body and comments count.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      issueNumber: { type: 'number', description: 'Issue number' },
    },
    required: ['owner', 'repo', 'issueNumber'],
  },
  handler: handleGetIssue,
};

export const listPullRequestsTool: ToolDefinition = {
  name: 'github_list_pull_requests',
  description: 'List pull requests in a repository.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', description: 'Filter by state: open, closed, all (default: open)' },
      perPage: { type: 'number', description: 'Results per page (default: 30, max: 100)' },
    },
    required: ['owner', 'repo'],
  },
  handler: handleListPullRequests,
};

export const getPullRequestTool: ToolDefinition = {
  name: 'github_get_pull_request',
  description: 'Get detailed information about a specific pull request.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      prNumber: { type: 'number', description: 'Pull request number' },
    },
    required: ['owner', 'repo', 'prNumber'],
  },
  handler: handleGetPullRequest,
};

export const getPullRequestDiffTool: ToolDefinition = {
  name: 'github_get_pull_request_diff',
  description: 'Get the diff of a pull request.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      prNumber: { type: 'number', description: 'Pull request number' },
    },
    required: ['owner', 'repo', 'prNumber'],
  },
  handler: handleGetPullRequestDiff,
};

export const getFileContentTool: ToolDefinition = {
  name: 'github_get_file_content',
  description: 'Get the content of a file or list directory contents from a repository.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      path: { type: 'string', description: 'File or directory path' },
      ref: { type: 'string', description: 'Branch, tag, or commit SHA (default: default branch)' },
    },
    required: ['owner', 'repo', 'path'],
  },
  handler: handleGetFileContent,
};

export const searchCodeTool: ToolDefinition = {
  name: 'github_search_code',
  description: 'Search for code across GitHub repositories. Use qualifiers like repo:owner/name, language:python, etc.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query with optional qualifiers (e.g., "addClass repo:jquery/jquery")' },
      perPage: { type: 'number', description: 'Results per page (default: 20, max: 100)' },
    },
    required: ['query'],
  },
  handler: handleSearchCode,
};

export const getUserTool: ToolDefinition = {
  name: 'github_get_user',
  description: 'Get information about the authenticated GitHub user.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: handleGetUser,
};

// ============================================================================
// Write tools (require repo scope)
// ============================================================================

export const createIssueTool: ToolDefinition = {
  name: 'github_create_issue',
  description: 'Create a new issue in a repository.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body (Markdown supported)' },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Labels to assign',
      },
      assignees: {
        type: 'array',
        items: { type: 'string' },
        description: 'Users to assign',
      },
    },
    required: ['owner', 'repo', 'title'],
  },
  handler: handleCreateIssue,
};

export const commentOnIssueTool: ToolDefinition = {
  name: 'github_comment_on_issue',
  description: 'Add a comment to an issue or pull request.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      issueNumber: { type: 'number', description: 'Issue or PR number' },
      body: { type: 'string', description: 'Comment body (Markdown supported)' },
    },
    required: ['owner', 'repo', 'issueNumber', 'body'],
  },
  handler: handleCommentOnIssue,
};

// ============================================================================
// Export all tools
// ============================================================================

export const githubTools: ToolDefinition[] = [
  // Read
  listReposTool,
  getRepoTool,
  listIssuesTool,
  getIssueTool,
  listPullRequestsTool,
  getPullRequestTool,
  getPullRequestDiffTool,
  getFileContentTool,
  searchCodeTool,
  getUserTool,
  // Write
  createIssueTool,
  commentOnIssueTool,
];

/**
 * Map of tool name -> required GitHub scope.
 * Tools that work with public repos need no scope,
 * but listing user repos requires 'repo' scope.
 */
export const TOOL_REQUIRED_SCOPES: Record<string, string | null> = {
  github_list_repos: 'repo',
  github_get_repo: null, // works for public repos without scope
  github_list_issues: null,
  github_get_issue: null,
  github_list_pull_requests: null,
  github_get_pull_request: null,
  github_get_pull_request_diff: null,
  github_get_file_content: null,
  github_search_code: null,
  github_get_user: null,
  github_create_issue: 'repo',
  github_comment_on_issue: 'repo',
};
