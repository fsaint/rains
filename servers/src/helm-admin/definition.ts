import type { ServiceDefinitionWithTools } from '../common/types.js';
import { helmAdminTools } from './tools.js';

/**
 * Helm Admin — organize the other agents on this account.
 *
 * **This service is different in kind from every other one here.** Gmail lets an
 * agent read mail. This lets an agent change what agents are allowed to do,
 * including its own agent. An agent holding it alongside anything else is not an
 * agent with two services; it is an agent with every service, two steps away.
 *
 * The backend therefore refuses to enable it next to anything except memory —
 * see assertServiceCombinationAllowed in backend/src/services/permissions.ts,
 * which is where the rule lives so it binds the dashboard and this server
 * identically. It must also stay out of `enableDefaultServices()`, alongside
 * skill-authoring, or every new agent would become an admin agent.
 *
 * Enabling it additionally requires every agent on the account to be closed to
 * unauthenticated MCP calls. Without that the restriction is decorative: an
 * agent id is a credential on an open endpoint, so an admin agent could grant a
 * peer access and then drive that peer directly.
 *
 * `toolPrefix` must not be a prefix of, or prefixed by, another service's —
 * getServiceTypeFromToolName resolves by first match over the definitions array.
 * `helm_admin_` is clear of all seventeen existing prefixes.
 */
export const definition: ServiceDefinitionWithTools = {
  type: 'helm-admin',
  name: 'Helm Admin',
  description: 'Organize your other agents — rename, describe, and manage what each one can reach',
  icon: 'ShieldCheck',
  category: 'productivity',
  toolPrefix: 'helm_admin_',
  auth: {
    type: 'none',
    required: false,
  },
  tools: helmAdminTools,
  permissions: {
    read: [
      'helm_admin_list_agents',
      'helm_admin_get_agent',
      'helm_admin_list_services',
    ],
    // Every write requires approval, and `defaultWritePermission` is
    // deliberately absent so it falls back to 'require_approval'. Setting it to
    // 'allow', as memory and skills do, would let an agent rewrite your
    // permission matrix unattended — the one outcome this whole design exists
    // to prevent. A rename is gated for the same reason as a grant: both are
    // this agent acting on your account without you watching.
    write: [
      'helm_admin_rename_agent',
      'helm_admin_set_description',
      'helm_admin_set_status',
      'helm_admin_enable_service',
      'helm_admin_disable_service',
      'helm_admin_set_permission_level',
    ],
    blocked: [],
  },
  permissionDescriptions: {
    read: 'See your agents, what each one can reach, and its deployment status',
    full: 'See your agents, and propose changes to their names, descriptions, and access. Every change requires your approval.',
  },
};
