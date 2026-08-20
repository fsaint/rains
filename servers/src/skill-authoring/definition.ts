import type { ServiceDefinitionWithTools } from '../common/types.js';
import { skillAuthoringTools } from './tools.js';

/**
 * Skill authoring — the write half of the skills system.
 *
 * **This service is the privilege boundary.** There is no agent role in this
 * codebase; an agent can author skills exactly when this service is enabled on
 * it, and every other agent gets SERVICE_NOT_ENABLED and never even sees the
 * tool names in tools/list. Enable it on the one architect agent and nowhere
 * else — in particular it must stay out of `enableDefaultServices()` in
 * backend/src/services/permissions.ts, which turns memory and skills on for
 * every new agent.
 *
 * `toolPrefix` must not be a prefix of, or prefixed by, another service's:
 * getServiceTypeFromToolName resolves by first match over the definitions
 * array. `skill_authoring_` and `skills_` are mutually non-prefixing.
 */
export const definition: ServiceDefinitionWithTools = {
  type: 'skill-authoring',
  name: 'Skill Authoring',
  description: 'Write and assign skills for the other agents on this account — for an architect agent',
  icon: 'PencilRuler',
  category: 'productivity',
  toolPrefix: 'skill_authoring_',
  auth: {
    type: 'none',
    required: false,
  },
  tools: skillAuthoringTools,
  permissions: {
    // Reading is not a policy change, so it is not gated. The write tools below
    // are what alter what another agent does, and an author that had to raise an
    // approval merely to read the text it is about to edit would make every
    // single-line fix a two-approval errand.
    read: ['skill_authoring_list', 'skill_authoring_get'],
    // Every write requires approval: a skill body is an instruction another
    // agent follows, so each edit is a policy change worth seeing before it
    // lands. Setting defaultWritePermission to 'allow' here (as memory does)
    // would silently remove that gate.
    write: [
      'skill_authoring_create',
      'skill_authoring_update',
      'skill_authoring_assign',
      'skill_authoring_unassign',
    ],
    blocked: [],
  },
  permissionDescriptions: {
    read: "Read your owner's skills, including ones this agent does not use",
    full: "Read your owner's skills. Creating, editing, and assigning them require your approval.",
  },
};
