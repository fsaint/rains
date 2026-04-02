/**
 * Notion MCP Server Tool Definitions
 */

import type { ToolDefinition } from '../common/base-server.js';
import {
  handleSearch,
  handleGetDatabase,
  handleQueryDatabase,
  handleGetPage,
  handleGetPageContent,
  handleCreatePage,
  handleUpdatePage,
  handleArchivePage,
} from './handlers.js';

// ============================================================================
// Read tools
// ============================================================================

export const searchTool: ToolDefinition = {
  name: 'notion_search',
  description: 'Search for databases and pages in the connected Notion workspace.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query text. Omit to list all accessible items.',
      },
      filter: {
        type: 'string',
        enum: ['database', 'page'],
        description: 'Filter results by type',
      },
      pageSize: {
        type: 'number',
        description: 'Number of results (default: 20, max: 100)',
      },
      startCursor: {
        type: 'string',
        description: 'Cursor for pagination',
      },
    },
  },
  handler: handleSearch,
};

export const getDatabaseTool: ToolDefinition = {
  name: 'notion_get_database',
  description: 'Get a database schema including its properties (columns) and their types.',
  inputSchema: {
    type: 'object',
    properties: {
      databaseId: {
        type: 'string',
        description: 'The ID of the database',
      },
    },
    required: ['databaseId'],
  },
  handler: handleGetDatabase,
};

export const queryDatabaseTool: ToolDefinition = {
  name: 'notion_query_database',
  description: 'Query rows from a Notion database with optional filters and sorts. Use notion_get_database first to see available properties.',
  inputSchema: {
    type: 'object',
    properties: {
      databaseId: {
        type: 'string',
        description: 'The ID of the database to query',
      },
      filter: {
        type: 'object',
        description: 'Notion filter object. Example: {"property":"Status","select":{"equals":"Done"}}. For compound filters use {"and":[...]} or {"or":[...]}',
      },
      sorts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            property: { type: 'string' },
            direction: { type: 'string', enum: ['ascending', 'descending'] },
          },
        },
        description: 'Sort criteria. Example: [{"property":"Created","direction":"descending"}]',
      },
      pageSize: {
        type: 'number',
        description: 'Number of rows to return (default: 20, max: 100)',
      },
      startCursor: {
        type: 'string',
        description: 'Cursor for pagination',
      },
    },
    required: ['databaseId'],
  },
  handler: handleQueryDatabase,
};

export const getPageTool: ToolDefinition = {
  name: 'notion_get_page',
  description: 'Get a page (database row) and its properties.',
  inputSchema: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'The ID of the page to retrieve',
      },
    },
    required: ['pageId'],
  },
  handler: handleGetPage,
};

export const getPageContentTool: ToolDefinition = {
  name: 'notion_get_page_content',
  description: 'Get the content blocks of a page (paragraphs, headings, lists, code blocks, etc.).',
  inputSchema: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'The ID of the page',
      },
      pageSize: {
        type: 'number',
        description: 'Number of blocks to return (default: 50, max: 100)',
      },
      startCursor: {
        type: 'string',
        description: 'Cursor for pagination',
      },
    },
    required: ['pageId'],
  },
  handler: handleGetPageContent,
};

// ============================================================================
// Write tools
// ============================================================================

export const createPageTool: ToolDefinition = {
  name: 'notion_create_page',
  description: 'Create a new page (row) in a Notion database. Use notion_get_database first to see the required property format.',
  inputSchema: {
    type: 'object',
    properties: {
      databaseId: {
        type: 'string',
        description: 'The ID of the parent database',
      },
      properties: {
        type: 'object',
        description: 'Page properties matching the database schema. Example: {"Name":{"title":[{"text":{"content":"My Page"}}]},"Status":{"select":{"name":"To Do"}}}',
      },
      children: {
        type: 'array',
        description: 'Optional array of block objects for page content',
      },
    },
    required: ['databaseId', 'properties'],
  },
  handler: handleCreatePage,
};

export const updatePageTool: ToolDefinition = {
  name: 'notion_update_page',
  description: 'Update properties of an existing page (database row).',
  inputSchema: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'The ID of the page to update',
      },
      properties: {
        type: 'object',
        description: 'Properties to update. Same format as create.',
      },
    },
    required: ['pageId', 'properties'],
  },
  handler: handleUpdatePage,
};

// ============================================================================
// Blocked tools
// ============================================================================

export const archivePageTool: ToolDefinition = {
  name: 'notion_archive_page',
  description: 'Archive (soft-delete) a page. This can be undone in Notion.',
  inputSchema: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'The ID of the page to archive',
      },
    },
    required: ['pageId'],
  },
  handler: handleArchivePage,
};

// ============================================================================
// Export all tools
// ============================================================================

export const notionTools: ToolDefinition[] = [
  // Read
  searchTool,
  getDatabaseTool,
  queryDatabaseTool,
  getPageTool,
  getPageContentTool,
  // Write
  createPageTool,
  updatePageTool,
  // Blocked by default
  archivePageTool,
];
