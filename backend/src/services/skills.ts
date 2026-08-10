/**
 * Skill availability
 *
 * A skill can declare the MCP services it needs (`required_services`). An
 * inbox-triage playbook is useless on an agent with no Gmail connected, so
 * this resolves — per agent — which of those services are actually usable.
 *
 * Two rules follow from it:
 *   - assignment is refused while a dependency is unmet (the API returns 409)
 *   - if a service is disconnected *after* assignment the row survives and the
 *     skill is reported as unavailable, so the agent can name the exact
 *     service the user needs to reconnect
 */

import { getAgentInstances } from './permissions.js';

/** Parse the TEXT-JSON `required_services` column, tolerating bad data. */
export function parseRequiredServices(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string');
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Service types this agent can actually use right now.
 *
 * getAgentInstances() already short-circuits credentialStatus to 'connected'
 * for services whose definition has `auth.required === false` (memory, skills,
 * browser), and attempts a token refresh before reporting 'expired' — so no
 * credential logic is duplicated here.
 */
export async function getSatisfiedServices(agentId: string): Promise<Set<string>> {
  const instances = await getAgentInstances(agentId);
  return new Set(
    instances
      .filter((i) => i.enabled && i.credentialStatus === 'connected')
      .map((i) => i.serviceType)
  );
}

/** Required services this agent is missing. Empty array means the skill is usable. */
export function missingServices(required: string[], satisfied: Set<string>): string[] {
  return required.filter((s) => !satisfied.has(s));
}

export interface SkillAvailability {
  available: boolean;
  missingServices: string[];
}

/**
 * Resolve availability for many skills against one agent in a single pass —
 * getAgentInstances() is expensive (per-instance credential + permission
 * lookups), so callers listing skills must not invoke it per row.
 */
export async function resolveAvailability(
  agentId: string,
  skills: Array<{ id: string; requiredServices: string[] }>
): Promise<Map<string, SkillAvailability>> {
  const satisfied = await getSatisfiedServices(agentId);
  const out = new Map<string, SkillAvailability>();
  for (const skill of skills) {
    const missing = missingServices(skill.requiredServices, satisfied);
    out.set(skill.id, { available: missing.length === 0, missingServices: missing });
  }
  return out;
}
