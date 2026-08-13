/**
 * Skill Authoring MCP Server Tool Definitions
 */

import type { ToolDefinition } from '../common/base-server.js';
import {
  handleListAuthoredSkills,
  handleCreateSkill,
  handleUpdateSkill,
  handleAssignSkill,
  handleUnassignSkill,
} from './handlers.js';

export const skillAuthoringListTool: ToolDefinition = {
  name: 'skill_authoring_list',
  description:
    "List every skill your owner has, with ids — including ones not assigned to you. " +
    'Call this before creating anything, so you extend an existing skill instead of duplicating it, ' +
    'and to get the skill_id that update and assign need. ' +
    'Entries marked read_only are platform skills and cannot be edited from here.',
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
    'The skill does nothing until assigned with skill_authoring_assign.',
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
    'changing one line — read the current version first. Platform skills cannot be edited.',
  inputSchema: {
    type: 'object',
    properties: {
      skill_id: { type: 'string', description: 'Skill id from skill_authoring_list' },
      name: { type: 'string' },
      description: { type: 'string' },
      body: { type: 'string', description: 'Full replacement Markdown instructions' },
      requires: { type: 'array', items: { type: 'string' } },
      version: { type: 'string' },
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
    'Refused if the target agent lacks a service the skill requires.',
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

export const skillAuthoringTools: ToolDefinition[] = [
  skillAuthoringListTool,
  skillAuthoringCreateTool,
  skillAuthoringUpdateTool,
  skillAuthoringAssignTool,
  skillAuthoringUnassignTool,
];
