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
  handleAddAttribute,
  handleRemoveAttribute,
  handleListTags,
  handleListScopes,
  handleCreateScope,
} from './handlers.js';

/**
 * The `scope` argument, defined once so its wording cannot drift between tools.
 *
 * Only the tools that address memory by content take it. The ones that address
 * an existing entry by id do not: an entry's scope is a fact about it, not a
 * parameter, and offering the argument there would invite the model to think
 * memory_update({scope}) moves an entry between scopes.
 */
const SCOPE_ARG = {
  type: 'string' as const,
  description:
    'Scope slug (e.g. "work"). Scopes are separate compartments of the vault that never ' +
    'mix — entries, links and relations cannot cross between them. Omit to use your ' +
    'default scope for writes, or to span every scope you can reach for reads. ' +
    'Call memory_list_scopes to see what is available.',
};

export const memoryGetRootTool: ToolDefinition = {
  name: 'memory_get_root',
  description:
    'Get the user\'s root memory index — a Markdown document linking to all significant memory entries. ' +
    'Call this at the start of every conversation to orient yourself with what you know. ' +
    'Returns your default scope\'s index, plus one for every other scope you can reach. ' +
    'Each root carries `version` — keep it and pass it as if_version to memory_update.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: SCOPE_ARG,
    },
  },
  handler: handleGetRoot,
};

export const memoryCreateTool: ToolDefinition = {
  name: 'memory_create',
  description:
    'Create a new memory entry. Types: note (general), person, company, project. ' +
    'Call this whenever you learn something durable about an entity — a name, a date, a ' +
    'decision, a role change; it is idempotent, so recording it is always safe. ' +
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
      scope: {
        ...SCOPE_ARG,
        description:
          SCOPE_ARG.description +
          ' If parent_id is given, the new entry inherits that parent\'s scope.',
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
    'Update an existing memory entry. For content, choose exactly one of: `content` (replace ' +
    'everything), `append` (add at the end), or `section` (edit one heading). Prefer section/append ' +
    'for large entries and for every index update — a full resend is a chance to silently drop a ' +
    'section. Returns the new `version`.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Entry ID to update' },
      title: { type: 'string', description: 'New title (optional)' },
      content: {
        type: 'string',
        description: 'New Markdown content — replaces the whole body. Prefer `section` or `append` for partial edits.',
      },
      append: {
        type: 'string',
        description:
          'Text to add at the end of the entry on a new line (include a leading blank line yourself ' +
          'for a paragraph break). Use this for "add a line to the index" — never resend the whole ' +
          'content. Mutually exclusive with content and section.',
      },
      section: {
        type: 'object',
        properties: {
          heading: { type: 'string', description: 'Heading text without the #s, e.g. "People". Case-insensitive, any level, first match wins.' },
          text: { type: 'string', description: 'Markdown for the section body.' },
          mode: {
            type: 'string',
            enum: ['replace', 'append'],
            description:
              'replace (default) swaps the body under the heading — nested subsections included — up to ' +
              'the next heading of the same or higher level, keeping the heading line; append adds text ' +
              'at the end of the section, creating "## Heading" at the end of the entry if it is missing.',
          },
        },
        required: ['heading', 'text'],
        description: 'Edit one Markdown section. Mutually exclusive with content and append.',
      },
      type: {
        type: 'string',
        enum: ['note', 'person', 'company', 'project', 'index'],
        description: 'New type (optional)',
      },
      if_version: {
        type: 'number',
        description:
          'The version you read (memory_get and memory_get_root return it). The update is refused ' +
          'with VERSION_CONFLICT if the entry changed since — re-read and re-apply your change. ' +
          'Always pass it when editing an index.',
      },
    },
    required: ['id'],
  },
  handler: handleUpdate,
};

export const memorySearchTool: ToolDefinition = {
  name: 'memory_search',
  description:
    'Full-text search across all memory entries. Call this before answering any question ' +
    'about a person, company, or project, even when you think you know the answer. ' +
    'Search before creating to avoid duplicates.',
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
      scope: SCOPE_ARG,
    },
    required: ['query'],
  },
  handler: handleSearch,
};

export const memoryListTool: ToolDefinition = {
  name: 'memory_list',
  description:
    'List memory entries, optionally filtered by type, parent entry, tag, or recency. ' +
    'Use to browse all people, companies, projects, or notes. ' +
    'Pass tag to filter entries that contain a specific #tag (e.g. tag="client" for #client). ' +
    'Pass since (ISO 8601 date) to return only entries updated on or after that date. ' +
    'Pass order to control sort: "updated" (default), "created", or "title".',
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
      tag: { type: 'string', description: 'Filter entries by tag (e.g. "client" for #client)' },
      since: { type: 'string', description: 'ISO 8601 date — return only entries updated at or after this date (e.g. "2026-05-01")' },
      order: { type: 'string', enum: ['updated', 'created', 'title'], description: 'Sort order (default: updated — most recently updated first)' },
      scope: SCOPE_ARG,
    },
  },
  handler: handleList,
};

export const memoryGetTool: ToolDefinition = {
  name: 'memory_get',
  description:
    'Get a single memory entry by ID or title, including its attributes and backlinks. ' +
    'A title must match exactly (case-insensitive). If the same title exists in more than ' +
    'one scope, or as two types in one scope, the call is refused and the candidates are ' +
    'listed with their ids — pass id, or narrow with scope/type. ' +
    'Use to drill into a specific person, company, project, or note.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Entry ID (takes precedence over title)' },
      title: { type: 'string', description: 'Exact entry title (used if id is not provided)' },
      type: {
        type: 'string',
        enum: ['note', 'person', 'company', 'project', 'index'],
        description: 'Narrow a title lookup by type (optional; ignored when id is given)',
      },
      scope: {
        ...SCOPE_ARG,
        description:
          'Which scope to look the title up in. Ignored when id is given, since an ' +
          'entry id already determines its scope.',
      },
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
    'Call this at the start of a dream session to survey what needs reorganization. ' +
    'Every row is labelled with its scope; pass scope to work through one at a time.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: SCOPE_ARG,
    },
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

export const memoryAddAttributeTool: ToolDefinition = {
  name: 'memory_add_attribute',
  description:
    'Add a label or relation attribute to a memory entry. ' +
    'Labels are key-value metadata (e.g. name="alias", value="Felipe"). ' +
    'Relations link to another entry by ID (e.g. name="works_at", value=<entry-id>). ' +
    'Use name="alias" to register an alternate name for an entity so future creates resolve to it.',
  inputSchema: {
    type: 'object',
    properties: {
      entry_id: { type: 'string', description: 'ID of the entry to add the attribute to' },
      type: { type: 'string', enum: ['label', 'relation'], description: 'Attribute type' },
      name: { type: 'string', description: 'Attribute name (e.g. alias, email, works_at)' },
      value: { type: 'string', description: 'Attribute value or target entry ID for relations' },
    },
    required: ['entry_id', 'type', 'name', 'value'],
  },
  handler: handleAddAttribute,
};

export const memoryRemoveAttributeTool: ToolDefinition = {
  name: 'memory_remove_attribute',
  description:
    'Remove an attribute from a memory entry by attribute ID. ' +
    'Get the attribute ID from memory_get (the attributes array on the entry). ' +
    'Use to remove wrong aliases or stale metadata.',
  inputSchema: {
    type: 'object',
    properties: {
      attribute_id: { type: 'string', description: 'ID of the attribute to remove' },
    },
    required: ['attribute_id'],
  },
  handler: handleRemoveAttribute,
};

export const memoryListTagsTool: ToolDefinition = {
  name: 'memory_list_tags',
  description: 'List all tags used in your memory vault with their entry counts. Use to discover what topics are tagged.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: SCOPE_ARG,
    },
  },
  handler: handleListTags,
};

export const memoryListScopesTool: ToolDefinition = {
  name: 'memory_list_scopes',
  description:
    'List the memory scopes you can reach. A scope is a separate compartment of the vault — ' +
    'work and personal memory kept apart, for instance — and nothing crosses between them. ' +
    'Call this before passing a scope anywhere else: slugs cannot be guessed, and naming one ' +
    'you cannot reach is refused.',
  inputSchema: { type: 'object', properties: {} },
  handler: handleListScopes,
};

export const memoryCreateScopeTool: ToolDefinition = {
  name: 'memory_create_scope',
  description:
    'Create a new memory scope — a compartment that will not mix with the others. ' +
    'Only for a genuinely separate context the user has asked to keep apart, such as a ' +
    'new client engagement. Check memory_list_scopes first: a near-duplicate of an ' +
    'existing slug is refused, and a vault split across too many scopes is hard to undo. ' +
    'Entries, links and relations can never move between scopes afterwards.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Human-readable name (e.g. "Acme Engagement")' },
      slug: { type: 'string', description: 'Short handle, lowercase kebab (e.g. "acme"). Derived from name if omitted.' },
      description: { type: 'string', description: 'What belongs in this scope (optional)' },
    },
    required: ['name'],
  },
  handler: handleCreateScope,
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
  memoryAddAttributeTool,
  memoryRemoveAttributeTool,
  memoryListTagsTool,
  memoryListScopesTool,
  memoryCreateScopeTool,
];
