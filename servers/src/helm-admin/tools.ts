/**
 * Helm Admin MCP Server Tool Definitions
 */

import type { ToolDefinition } from '../common/base-server.js';
import {
  handleListAgents,
  handleGetAgent,
  handleListServices,
  handleRenameAgent,
  handleSetDescription,
  handleSetStatus,
  handleEnableService,
  handleDisableService,
  handleSetPermissionLevel,
  handleCreateAgent,
  handleDestroyAgent,
  handleSetToolPermission,
  handleResetToolPermission,
} from './handlers.js';

const agentIdProperty = {
  agentId: {
    type: 'string' as const,
    description: 'The agent id, from helm_admin_list_agents',
  },
};

// ── Reads ────────────────────────────────────────────────────────────────────

export const listAgentsTool: ToolDefinition = {
  name: 'helm_admin_list_agents',
  description:
    "List your owner's agents with their ids, names, descriptions, status, and which services each one can reach. " +
    'Start here — every other tool addresses an agent by the id this returns.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: handleListAgents,
};

export const getAgentTool: ToolDefinition = {
  name: 'helm_admin_get_agent',
  description:
    'Read one agent in full: its services, the permission level of each, and its deployment status. ' +
    'Use this before proposing a change, so you can say what the change actually alters.',
  inputSchema: {
    type: 'object',
    properties: { ...agentIdProperty },
    required: ['agentId'],
  },
  handler: handleGetAgent,
};

export const listServicesTool: ToolDefinition = {
  name: 'helm_admin_list_services',
  description:
    'List the service types that can be enabled on an agent — the catalog, not what any one agent has. ' +
    'Use it to check a serviceType is real before calling helm_admin_enable_service.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: handleListServices,
};

// ── Writes ───────────────────────────────────────────────────────────────────
// Each of these requires your owner's approval before it takes effect. Expect
// APPROVAL_PENDING and poll, rather than assuming the change landed.

export const renameAgentTool: ToolDefinition = {
  name: 'helm_admin_rename_agent',
  description:
    "Rename an agent. Names are how your owner tells their agents apart, so prefer what the agent is for " +
    '("Work Email") over what it runs. Requires your owner\'s approval.',
  inputSchema: {
    type: 'object',
    properties: {
      ...agentIdProperty,
      name: { type: 'string', description: 'The new name' },
    },
    required: ['agentId', 'name'],
  },
  handler: handleRenameAgent,
};

export const setDescriptionTool: ToolDefinition = {
  name: 'helm_admin_set_description',
  description:
    'Set an agent\'s description — one or two sentences on what it is for and when to use it. ' +
    'Pass an empty string to clear it. Requires your owner\'s approval.',
  inputSchema: {
    type: 'object',
    properties: {
      ...agentIdProperty,
      description: { type: 'string', description: 'The new description; empty string clears it' },
    },
    required: ['agentId', 'description'],
  },
  handler: handleSetDescription,
};

export const setStatusTool: ToolDefinition = {
  name: 'helm_admin_set_status',
  description:
    "Set an agent's status, e.g. to park one that is no longer in use. " +
    'This does not destroy the agent or its data. Requires your owner\'s approval.',
  inputSchema: {
    type: 'object',
    properties: {
      ...agentIdProperty,
      status: {
        type: 'string',
        description: 'The new status',
        enum: ['active', 'paused', 'inactive'],
      },
    },
    required: ['agentId', 'status'],
  },
  handler: handleSetStatus,
};

export const enableServiceTool: ToolDefinition = {
  name: 'helm_admin_enable_service',
  description:
    'Give an agent access to a service, e.g. gmail or calendar. This widens what that agent can do, ' +
    'so propose it only when your owner has asked for it and say why. ' +
    'You cannot grant helm-admin, and you cannot grant anything to an agent whose MCP endpoint still ' +
    'accepts unauthenticated calls. Requires your owner\'s approval.',
  inputSchema: {
    type: 'object',
    properties: {
      ...agentIdProperty,
      serviceType: {
        type: 'string',
        description: 'Service type from helm_admin_list_services, e.g. "gmail"',
      },
    },
    required: ['agentId', 'serviceType'],
  },
  handler: handleEnableService,
};

export const disableServiceTool: ToolDefinition = {
  name: 'helm_admin_disable_service',
  description:
    'Remove an agent\'s access to a service. The agent keeps its credentials elsewhere; this only ' +
    'stops that agent reaching them. You cannot remove helm-admin. Requires your owner\'s approval.',
  inputSchema: {
    type: 'object',
    properties: {
      ...agentIdProperty,
      serviceType: { type: 'string', description: 'Service type to remove, e.g. "gmail"' },
    },
    required: ['agentId', 'serviceType'],
  },
  handler: handleDisableService,
};

export const setPermissionLevelTool: ToolDefinition = {
  name: 'helm_admin_set_permission_level',
  description:
    'Set how much of a service an agent may use: "read" for read-only tools, "full" to also allow ' +
    'writes (which themselves prompt your owner), or "none" to turn the service off. ' +
    'Requires your owner\'s approval.',
  inputSchema: {
    type: 'object',
    properties: {
      ...agentIdProperty,
      serviceType: { type: 'string', description: 'Service type, e.g. "gmail"' },
      level: {
        type: 'string',
        description: 'The permission level',
        enum: ['none', 'read', 'full'],
      },
    },
    required: ['agentId', 'serviceType', 'level'],
  },
  handler: handleSetPermissionLevel,
};

export const createAgentTool: ToolDefinition = {
  name: 'helm_admin_create_agent',
  description:
    'Create a new agent. It gets an MCP endpoint that requires a token from the moment it exists, ' +
    'so unlike an agent created in the dashboard nobody can reach it just by knowing its id. ' +
    'It has no runtime — your owner connects it to a client, or deploys it, afterwards. ' +
    'Memory and skills are on by default; add anything else with helm_admin_enable_service. ' +
    "Requires your owner's approval.",
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'What the agent is for, e.g. "Work Email"' },
      description: { type: 'string', description: 'One or two sentences on when to use it' },
    },
    required: ['name'],
  },
  handler: handleCreateAgent,
};

export const destroyAgentTool: ToolDefinition = {
  name: 'helm_admin_destroy_agent',
  description:
    'Permanently destroy an agent: its runtime machine and all of its permissions and credentials links. ' +
    'This cannot be undone. Notes it wrote to memory survive, because those belong to your owner. ' +
    'You cannot destroy yourself, or any agent that has Helm Admin. ' +
    'Read the agent with helm_admin_get_agent first and tell your owner what will be lost — ' +
    "the approval names the agent, and they should recognise it. Requires your owner's approval.",
  inputSchema: {
    type: 'object',
    properties: { ...agentIdProperty },
    required: ['agentId'],
  },
  handler: handleDestroyAgent,
};

export const setToolPermissionTool: ToolDefinition = {
  name: 'helm_admin_set_tool_permission',
  description:
    'Override one tool on an agent, rather than the whole service: "allow" to let it run freely, ' +
    '"require_approval" to make it prompt your owner each time, or "block" to refuse it outright. ' +
    'Use this to loosen or tighten a single tool without changing the rest of the service — ' +
    'blocking gmail_send_message while leaving the rest of Gmail readable, say. ' +
    "Requires your owner's approval.",
  inputSchema: {
    type: 'object',
    properties: {
      ...agentIdProperty,
      toolName: {
        type: 'string',
        description: 'The tool to override, e.g. "gmail_send_message". Its service is worked out for you.',
      },
      permission: {
        type: 'string',
        description: 'How the agent may use that tool',
        enum: ['allow', 'require_approval', 'block'],
      },
    },
    required: ['agentId', 'toolName', 'permission'],
  },
  handler: handleSetToolPermission,
};

export const resetToolPermissionTool: ToolDefinition = {
  name: 'helm_admin_reset_tool_permission',
  description:
    'Remove a per-tool override, so the tool goes back to whatever its service permission level implies. ' +
    "Requires your owner's approval.",
  inputSchema: {
    type: 'object',
    properties: {
      ...agentIdProperty,
      toolName: { type: 'string', description: 'The tool whose override should be removed' },
    },
    required: ['agentId', 'toolName'],
  },
  handler: handleResetToolPermission,
};

export const helmAdminTools: ToolDefinition[] = [
  listAgentsTool,
  getAgentTool,
  listServicesTool,
  createAgentTool,
  destroyAgentTool,
  renameAgentTool,
  setDescriptionTool,
  setStatusTool,
  enableServiceTool,
  disableServiceTool,
  setPermissionLevelTool,
  setToolPermissionTool,
  resetToolPermissionTool,
];
