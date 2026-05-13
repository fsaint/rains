/**
 * Memory MCP Server Tool Definitions
 */

import type { ToolDefinition } from '../common/base-server.js';
import {
  handleGetRoot,
  handleCreate,
  handleUpdate,
  handleSearch,
  handleList,
  handleGet,
  handleRelate,
  handleDelete,
  handleDream,
  handleSetParent,
} from './handlers.js';

export const memoryGetRootTool: ToolDefinition = {
  name: 'memory_get_root',
  description:
    'Get the user\'s root memory index — a Markdown document linking to all significant memory entries. ' +
    'Call this at the start of every conversation to orient yourself with what you know.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: handleGetRoot,
};

export const memoryCreateTool: ToolDefinition = {
  name: 'memory_create',
  description:
    'Create a new memory entry. Types: note (general), person, company, project. ' +
    'Use [[Title]] wikilinks in content to link to other entries. ' +
    'After creating a significant entry, update the root index with memory_update.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Entry title (must be unique within your vault)' },
      type: {
        type: 'string',
        enum: ['note', 'person', 'company', 'project'],
        description: 'Entry type. Default: note',
      },
      content: {
        type: 'string',
        description: 'Markdown body. Use [[Title]] to link to other entries.',
      },
      parent_id: {
        type: 'string',
        description: 'Parent entry ID (optional — for nesting under a section)',
      },
      attributes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['label', 'relation'] },
            name: { type: 'string', description: 'Label key or relation name (e.g. email, works_at)' },
            value: { type: 'string', description: 'Label value or target entry ID for relations' },
          },
          required: ['type', 'name', 'value'],
        },
        description: 'Initial labels (key-value metadata) or relations (links to other entries)',
      },
    },
    required: ['title'],
  },
  handler: handleCreate,
};

export const memoryUpdateTool: ToolDefinition = {
  name: 'memory_update',
  description:
    'Update an existing memory entry — title, content, or type. ' +
    'Use this to keep entries current and to update the root index when you add significant knowledge.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Entry ID to update' },
      title: { type: 'string', description: 'New title (optional)' },
      content: { type: 'string', description: 'New Markdown content (optional — replaces existing)' },
      type: {
        type: 'string',
        enum: ['note', 'person', 'company', 'project', 'index'],
        description: 'New type (optional)',
      },
    },
    required: ['id'],
  },
  handler: handleUpdate,
};

export const memorySearchTool: ToolDefinition = {
  name: 'memory_search',
  description:
    'Full-text search across all memory entries. Search before creating to avoid duplicates.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query text' },
      type: {
        type: 'string',
        enum: ['note', 'person', 'company', 'project'],
        description: 'Filter by entry type (optional)',
      },
      limit: { type: 'number', description: 'Max results (default: 20, max: 50)' },
    },
    required: ['query'],
  },
  handler: handleSearch,
};

export const memoryListTool: ToolDefinition = {
  name: 'memory_list',
  description:
    'List memory entries, optionally filtered by type or parent entry. ' +
    'Use to browse all people, companies, projects, or notes.',
  inputSchema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['note', 'person', 'company', 'project'],
        description: 'Filter by type (optional)',
      },
      parent_id: { type: 'string', description: 'List children of this entry ID (optional)' },
      limit: { type: 'number', description: 'Max results (default: 50, max: 200)' },
    },
  },
  handler: handleList,
};

export const memoryGetTool: ToolDefinition = {
  name: 'memory_get',
  description:
    'Get a single memory entry by ID or title, including its attributes and backlinks. ' +
    'Use to drill into a specific person, company, project, or note.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Entry ID (takes precedence over title)' },
      title: { type: 'string', description: 'Exact entry title (used if id is not provided)' },
    },
  },
  handler: handleGet,
};

export const memoryRelateTool: ToolDefinition = {
  name: 'memory_relate',
  description:
    'Create a named relation between two memory entries. ' +
    'Examples: person works_at company, person manages person, project uses_tool note.',
  inputSchema: {
    type: 'object',
    properties: {
      source_id: { type: 'string', description: 'Source entry ID' },
      relation: { type: 'string', description: 'Relation name (e.g. works_at, manages, part_of)' },
      target_id: { type: 'string', description: 'Target entry ID' },
    },
    required: ['source_id', 'relation', 'target_id'],
  },
  handler: handleRelate,
};

export const memoryDeleteTool: ToolDefinition = {
  name: 'memory_delete',
  description: 'Soft-delete a memory entry. The entry is hidden but not permanently removed.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Entry ID to delete' },
    },
    required: ['id'],
  },
  handler: handleDelete,
};

export const memoryDreamTool: ToolDefinition = {
  name: 'memory_dream',
  description:
    'Get a compact manifest of your entire memory vault — all entries with type, parent, and backlink count. ' +
    'Call this at the start of a dream session to survey what needs reorganization.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: handleDream,
};

export const memorySetParentTool: ToolDefinition = {
  name: 'memory_set_parent',
  description:
    'Move a memory entry to a new parent. Use during dream sessions to reorganize the vault tree. ' +
    'Set parent_id to null to move an entry to the top level (below root).',
  inputSchema: {
    type: 'object',
    properties: {
      entry_id: { type: 'string', description: 'ID of the entry to move' },
      parent_id: {
        type: ['string', 'null'],
        description: 'New parent entry ID, or null to place at top level',
      },
    },
    required: ['entry_id', 'parent_id'],
  },
  handler: handleSetParent,
};

export const memoryTools: ToolDefinition[] = [
  memoryGetRootTool,
  memoryCreateTool,
  memoryUpdateTool,
  memorySearchTool,
  memoryListTool,
  memoryGetTool,
  memoryRelateTool,
  memoryDeleteTool,
  memoryDreamTool,
  memorySetParentTool,
];
