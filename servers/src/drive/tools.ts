/**
 * Google Drive MCP Server Tool Definitions
 */

import type { ToolDefinition } from '../common/base-server.js';
import {
  handleListFiles,
  handleGetFile,
  handleReadFile,
  handleSearch,
  handleCreateFile,
  handleUpdateFile,
  handleShareFile,
  handleDeleteFile,
  handleListSharedDrives,
} from './handlers.js';

/**
 * List files in Drive
 */
export const listFilesTool: ToolDefinition = {
  name: 'drive_list_files',
  description:
    'List files in Google Drive. Returns file metadata including names, IDs, and types.',
  inputSchema: {
    type: 'object',
    properties: {
      folderId: {
        type: 'string',
        description:
          'ID of folder to list. Use "root" for root folder, or omit for all files.',
      },
      pageSize: {
        type: 'number',
        description: 'Number of files to return (default: 20, max: 100)',
      },
      pageToken: {
        type: 'string',
        description: 'Token for pagination',
      },
      orderBy: {
        type: 'string',
        description:
          'Sort order (e.g., "modifiedTime desc", "name", "createdTime")',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Fields to include (default: id, name, mimeType, size, modifiedTime)',
      },
    },
  },
  handler: handleListFiles,
};

/**
 * Get file metadata
 */
export const getFileTool: ToolDefinition = {
  name: 'drive_get_file',
  description: 'Get metadata for a specific file in Google Drive.',
  inputSchema: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'The ID of the file',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Fields to include (default: id, name, mimeType, size, modifiedTime, createdTime, parents, webViewLink)',
      },
    },
    required: ['fileId'],
  },
  handler: handleGetFile,
};

/**
 * Read file content
 */
export const readFileTool: ToolDefinition = {
  name: 'drive_read_file',
  description:
    'Read the content of a file. Works with Google Docs, Sheets, text files, and more. Binary files return metadata only.',
  inputSchema: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'The ID of the file to read',
      },
      mimeType: {
        type: 'string',
        description:
          'Export MIME type for Google Docs (e.g., "text/plain", "text/html", "application/pdf")',
      },
      maxSize: {
        type: 'number',
        description: 'Maximum content size in bytes (default: 1MB)',
      },
    },
    required: ['fileId'],
  },
  handler: handleReadFile,
};

/**
 * Search files
 */
export const searchTool: ToolDefinition = {
  name: 'drive_search',
  description:
    'Search for files in Google Drive using query syntax.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          "Search query. Supports: name contains 'X', mimeType='X', 'email' in owners, modifiedTime > 'date', fullText contains 'X'",
      },
      pageSize: {
        type: 'number',
        description: 'Number of results (default: 20, max: 100)',
      },
      includeSharedDrives: {
        type: 'boolean',
        description: 'Include shared drives in search',
      },
    },
    required: ['query'],
  },
  handler: handleSearch,
};

/**
 * Create a file
 */
export const createFileTool: ToolDefinition = {
  name: 'drive_create_file',
  description:
    'Create a new file in Google Drive: folders, documents, spreadsheets, inline text content — ' +
    'or upload a real file (PDF, image, anything binary) via the `file` parameter.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the file. Defaults to the filename carried by `file` when omitted.',
      },
      mimeType: {
        type: 'string',
        description:
          'Target MIME type (e.g., "application/vnd.google-apps.document", "application/vnd.google-apps.folder", ' +
          '"text/plain"). With a `file` source, naming a Google Workspace type converts the upload ' +
          '(e.g. a .docx file into a Google Doc).',
      },
      content: {
        type: 'string',
        description: 'File content (for text files). For binary or staged files use `file` instead.',
      },
      file: {
        type: 'object',
        description:
          'The file bytes, from a reference source — use this to upload real files. Same shape as a ' +
          'Gmail attachment: {"source":"upload","uploadId":…} for a file staged via /api/agent-uploads ' +
          '(up to 20 MB; the bytes never enter your context), {"source":"base64","filename":…,"mimeType":…,"data":…} ' +
          'for small inline files (≤384 KB decoded), {"source":"url","url":…} to fetch over HTTPS, ' +
          '{"source":"gmail","messageId":…,"attachmentId":…} to save an email attachment to Drive, ' +
          '{"source":"drive","fileId":…} to copy or export an existing Drive file, or ' +
          '{"source":"text","filename":…,"content":…}. Mutually exclusive with content.',
      },
      parentId: {
        type: 'string',
        description: 'ID of parent folder (default: root)',
      },
    },
    required: [],
  },
  handler: handleCreateFile,
};

/**
 * Update a file
 */
export const updateFileTool: ToolDefinition = {
  name: 'drive_update_file',
  description:
    'Update an existing file: metadata, or replace its content with `content` (plain text) or ' +
    '`file` (real bytes from any source).',
  inputSchema: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'The ID of the file to update',
      },
      name: {
        type: 'string',
        description: 'New name for the file',
      },
      content: {
        type: 'string',
        description: 'New content (for text files). For binary or staged files use `file` instead.',
      },
      file: {
        type: 'object',
        description:
          'The file bytes, from a reference source — use this to upload real files. Same shape as a ' +
          'Gmail attachment: {"source":"upload","uploadId":…} for a file staged via /api/agent-uploads ' +
          '(up to 20 MB; the bytes never enter your context), {"source":"base64","filename":…,"mimeType":…,"data":…} ' +
          'for small inline files (≤384 KB decoded), {"source":"url","url":…} to fetch over HTTPS, ' +
          '{"source":"gmail","messageId":…,"attachmentId":…} to save an email attachment to Drive, ' +
          '{"source":"drive","fileId":…} to copy or export an existing Drive file, or ' +
          '{"source":"text","filename":…,"content":…}. Mutually exclusive with content.',
      },

      addParents: {
        type: 'array',
        items: { type: 'string' },
        description: 'Folder IDs to add as parents',
      },
      removeParents: {
        type: 'array',
        items: { type: 'string' },
        description: 'Folder IDs to remove as parents',
      },
    },
    required: ['fileId'],
  },
  handler: handleUpdateFile,
};

/**
 * Share a file
 */
export const shareFileTool: ToolDefinition = {
  name: 'drive_share_file',
  description: 'Share a file or change sharing settings.',
  inputSchema: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'The ID of the file to share',
      },
      email: {
        type: 'string',
        description: 'Email address to share with',
      },
      role: {
        type: 'string',
        enum: ['reader', 'commenter', 'writer', 'owner'],
        description: 'Permission level',
      },
      type: {
        type: 'string',
        enum: ['user', 'group', 'domain', 'anyone'],
        description: 'Type of permission',
      },
      sendNotification: {
        type: 'boolean',
        description: 'Send email notification (default: true)',
      },
    },
    required: ['fileId', 'role', 'type'],
  },
  handler: handleShareFile,
};

/**
 * Delete a file
 */
export const deleteFileTool: ToolDefinition = {
  name: 'drive_delete_file',
  description:
    'Delete a file from Google Drive. This moves it to trash (can be recovered within 30 days).',
  inputSchema: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'The ID of the file to delete',
      },
      permanent: {
        type: 'boolean',
        description: 'Permanently delete instead of moving to trash',
      },
    },
    required: ['fileId'],
  },
  handler: handleDeleteFile,
};

/**
 * List shared drives
 */
export const listSharedDrivesTool: ToolDefinition = {
  name: 'drive_list_shared_drives',
  description: 'List all shared drives the user has access to.',
  inputSchema: {
    type: 'object',
    properties: {
      pageSize: {
        type: 'number',
        description: 'Number of shared drives to return (default: 10, max: 100)',
      },
      pageToken: {
        type: 'string',
        description: 'Token for pagination',
      },
    },
  },
  handler: handleListSharedDrives,
};

/**
 * All Drive tools
 */
export const driveTools: ToolDefinition[] = [
  listFilesTool,
  getFileTool,
  readFileTool,
  searchTool,
  createFileTool,
  updateFileTool,
  shareFileTool,
  deleteFileTool,
  listSharedDrivesTool,
];
