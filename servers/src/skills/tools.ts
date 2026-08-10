/**
 * Skills MCP Server Tool Definitions
 */

import type { ToolDefinition } from '../common/base-server.js';
import { handleListSkills, handleGetSkill } from './handlers.js';

/**
 * List assigned skills.
 *
 * The description carries the behavioural instruction because, unlike
 * filesystem skills, nothing else tells the model these exist — the same
 * lever reins_get_result uses to teach its own polling protocol.
 */
export const skillsListTool: ToolDefinition = {
  name: 'skills_list',
  description:
    'List the skills available to you — reusable, human-authored playbooks for specific recurring tasks ' +
    '(triaging an inbox, running a weekly report, onboarding a client). ' +
    'CALL THIS FIRST whenever a request looks like a repeatable or non-trivial workflow, BEFORE planning ' +
    'your own approach — a skill may already encode exactly how your owner wants it done. ' +
    "Returns each skill's slug, name, a one-line \"when to use this\" description, the services it requires, " +
    'and whether those services are currently connected to you. ' +
    'Then call skills_get with the slug to read the full instructions. ' +
    'Skills are edited by your owner in the Reins dashboard and can change at any time — always re-read a ' +
    'skill rather than relying on memory of it from an earlier session.',
  inputSchema: {
    type: 'object',
    properties: {
      include_unavailable: {
        type: 'boolean',
        description:
          'Include skills whose required services are not connected. Default true; those entries come ' +
          'back with available=false and missing_services populated so you can tell the user what to reconnect.',
      },
    },
  },
  handler: handleListSkills,
};

export const skillsGetTool: ToolDefinition = {
  name: 'skills_get',
  description:
    'Fetch the full Markdown instructions for one skill, by the slug returned from skills_list. ' +
    'Read the entire body and follow it — it reflects how your owner wants this task done. ' +
    'If the response includes unavailable_services, you cannot fully execute this skill: tell the user ' +
    'exactly which service to connect in the Reins dashboard (Agents -> your agent -> Services) and do ' +
    'not improvise a workaround.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description: 'Skill slug, exactly as returned by skills_list',
      },
    },
    required: ['slug'],
  },
  handler: handleGetSkill,
};

export const skillsTools: ToolDefinition[] = [skillsListTool, skillsGetTool];
