/**
 * Skill Authoring MCP Server Tool Definitions
 */

import type { ToolDefinition } from '../common/base-server.js';
import {
  handleListAuthoredSkills,
  handleGetAuthoredSkill,
  handleCreateSkill,
  handleUpdateSkill,
  handleDeleteSkill,
  handleAssignSkill,
  handleUnassignSkill,
} from './handlers.js';

/**
 * Shared by every write tool. Defined once so the wording an agent reads about
 * platform scope cannot drift between create, update, and delete.
 */
const scopeProperty = {
  scope: {
    type: 'string',
    enum: ['user', 'system'],
    description:
      'Who the skill belongs to. "user" (the default) writes a skill for your owner\'s account ' +
      'only. "system" writes a Helm platform skill that every account on the platform can load; ' +
      'it is refused unless your owner is a Helm admin. Never pass "system" to fix something for ' +
      'one person.',
  },
} as const;

export const skillAuthoringListTool: ToolDefinition = {
  name: 'skill_authoring_list',
  description:
    "List every skill your owner has, with ids — including ones not assigned to you. " +
    'Call this before creating anything, so you extend an existing skill instead of duplicating it, ' +
    'and to get the skill_id that update and assign need. ' +
    'Entries with scope "system" are Helm platform skills; editing one needs scope:"system" and ' +
    'an admin owner. Entries marked read_only are ones you cannot edit.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: handleListAuthoredSkills,
};

export const skillAuthoringCreateTool: ToolDefinition = {
  name: 'skill_authoring_create',
  description:
    'Author a new skill for your owner. The body is Markdown instructions another agent will follow ' +
    'literally, so write a procedure, not a description of one. ' +
    'Name tools as {{tool:gmail_search}} and other skills as {{skill:its-slug}} — those tokens are ' +
    'rendered into the exact names each reading agent sees, which differ between agent runtimes. ' +
    'The skill does nothing until assigned with skill_authoring_assign. ' +
    'Pass scope:"system" only when the skill should ship to every account on the platform; the ' +
    'default writes it for your owner alone.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Human-readable name, e.g. "Inbox Triage"' },
      description: {
        type: 'string',
        description:
          'One line answering "when should the agent use this?". This is the only text an agent sees before loading the skill, so it decides whether the skill is ever opened.',
      },
      body: { type: 'string', description: 'Full Markdown instructions' },
      requires: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Service types the skill needs (e.g. ["gmail"]). Assignment is refused for an agent that lacks them, so declare only what the procedure actually calls.',
      },
      slug: { type: 'string', description: 'Optional URL-safe slug; derived from name when omitted' },
      version: { type: 'string', description: 'Optional version stamp' },
      ...scopeProperty,
    },
    required: ['name', 'description', 'body'],
  },
  handler: handleCreateSkill,
};

export const skillAuthoringUpdateTool: ToolDefinition = {
  name: 'skill_authoring_update',
  description:
    'Replace the contents of one of your owner\'s skills, by skill_id from skill_authoring_list. ' +
    'This overwrites the whole skill, so send the complete name, description and body even when ' +
    'changing one line — read the current version first. Editing a platform skill requires ' +
    'scope:"system" and an admin owner; skill_authoring_get tells you which kind a skill is.',
  inputSchema: {
    type: 'object',
    properties: {
      skill_id: { type: 'string', description: 'Skill id from skill_authoring_list' },
      name: { type: 'string' },
      description: { type: 'string' },
      body: { type: 'string', description: 'Full replacement Markdown instructions' },
      requires: { type: 'array', items: { type: 'string' } },
      version: { type: 'string' },
      ...scopeProperty,
    },
    required: ['skill_id', 'name', 'description', 'body'],
  },
  handler: handleUpdateSkill,
};

export const skillAuthoringAssignTool: ToolDefinition = {
  name: 'skill_authoring_assign',
  description:
    "Attach a skill to one of your owner's agents, which is what makes the agent start using it. " +
    'Adds to whatever that agent already has; it never replaces the rest. ' +
    'Refused if the target agent lacks a service the skill requires. ' +
    "Platform skills can be attached to your owner's agents even when you cannot edit them.",
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Target agent id' },
      skill_id: { type: 'string', description: 'Skill id from skill_authoring_list' },
    },
    required: ['agent_id', 'skill_id'],
  },
  handler: handleAssignSkill,
};

export const skillAuthoringUnassignTool: ToolDefinition = {
  name: 'skill_authoring_unassign',
  description:
    "Detach a skill from one of your owner's agents. The skill itself is kept and can be reattached.",
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Target agent id' },
      skill_id: { type: 'string', description: 'Skill id from skill_authoring_list' },
    },
    required: ['agent_id', 'skill_id'],
  },
  handler: handleUnassignSkill,
};

export const skillAuthoringGetTool: ToolDefinition = {
  name: 'skill_authoring_get',
  description:
    "Read one skill in full, including its body — any of your owner's skills, whether or not it is " +
    'assigned to you and whatever services it requires. ' +
    'Call this before skill_authoring_update: that tool replaces the whole skill, so you need the ' +
    'current text to edit rather than rewrite from memory. ' +
    'The body comes back exactly as stored, with {{tool:…}} and {{skill:…}} tokens intact — keep ' +
    'them as tokens when you write it back, since they are what makes the skill work across runtimes. ' +
    'Accepts an id from skill_authoring_list, or a slug, which is what {{skill:its-slug}} references ' +
    'inside a body give you.',
  inputSchema: {
    type: 'object',
    properties: {
      skill_id: {
        type: 'string',
        description: 'Skill id from skill_authoring_list, or a slug',
      },
    },
    required: ['skill_id'],
  },
  handler: handleGetAuthoredSkill,
};

export const skillAuthoringDeleteTool: ToolDefinition = {
  name: 'skill_authoring_delete',
  description:
    "Permanently delete one of your owner's skills. It is detached from every agent that has it " +
    'and the body is not recoverable — prefer skill_authoring_unassign when you only want one ' +
    'agent to stop using it. With scope:"system" it deletes a Helm platform skill, removing it ' +
    'from every account on the platform; that requires an admin owner.',
  inputSchema: {
    type: 'object',
    properties: {
      skill_id: { type: 'string', description: 'Skill id from skill_authoring_list' },
      ...scopeProperty,
    },
    required: ['skill_id'],
  },
  handler: handleDeleteSkill,
};

export const skillAuthoringTools: ToolDefinition[] = [
  skillAuthoringListTool,
  skillAuthoringGetTool,
  skillAuthoringCreateTool,
  skillAuthoringUpdateTool,
  skillAuthoringDeleteTool,
  skillAuthoringAssignTool,
  skillAuthoringUnassignTool,
];
