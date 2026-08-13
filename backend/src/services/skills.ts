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
import { extractSkillReferences } from '@reins/shared';

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

// ============================================================================
// Reachability through {{skill:...}} references
// ============================================================================

/**
 * Referencing a skill grants access to it, so an agent's effective skill set is
 * the transitive closure of what it was assigned.
 *
 * There is no stored edge set — relationships are written inline in bodies as
 * `{{skill:slug}}` — so the graph is derived here at request time by scanning
 * the bodies the agent can already see.
 */

/** How many reference hops out from the assigned set are followed. */
export const SKILL_REFERENCE_MAX_DEPTH = 5;

/** Hard ceiling on skills inspected, so a pathological graph cannot run away. */
export const SKILL_REFERENCE_MAX_VISITED = 200;

export interface ReferenceableSkill {
  slug: string;
  /** null for system skills; a user id for skills that user owns. */
  userId: string | null;
  body: string;
}

export type SkillReachability<T> =
  | { reachable: true; skill: T }
  /** `not_found`: no such slug in scope. `not_reachable`: exists, nothing points at it. */
  | { reachable: false; reason: 'not_found' | 'not_reachable' };

/**
 * Pick one skill for a slug.
 *
 * `slug` is unique among system skills and unique per user, but NOT globally
 * (backend/src/db/index.ts) — so a user skill can shadow a system one. The
 * owner's own skill wins: overriding a stock skill is the intuitive reading,
 * and picking deterministically is what stops the old `find()`-over-a-UNION
 * ambiguity from becoming load-bearing now that slugs are addressable.
 */
function pickBySlug<T extends ReferenceableSkill>(candidates: T[], slug: string): T | undefined {
  const matches = candidates.filter((c) => c.slug === slug);
  return matches.find((c) => c.userId !== null) ?? matches[0];
}

/**
 * Resolve `slug` for an agent, following references out from its assigned set.
 *
 * `candidates` is the caller's security boundary: it must already be scoped to
 * system skills plus the agent owner's own. A slug outside that set is reported
 * `not_found` rather than reached, so a reference can never cross to another
 * user's skill however it is spelled.
 */
export function resolveReachableSkill<T extends ReferenceableSkill>(
  slug: string,
  assigned: T[],
  candidates: T[]
): SkillReachability<T> {
  const direct = pickBySlug(assigned, slug);
  if (direct) return { reachable: true, skill: direct };

  const target = pickBySlug(candidates, slug);
  if (!target) return { reachable: false, reason: 'not_found' };

  const visited = new Set(assigned.map((s) => s.slug));
  let frontier = assigned;

  for (let depth = 0; depth < SKILL_REFERENCE_MAX_DEPTH; depth++) {
    const next: T[] = [];

    for (const source of frontier) {
      for (const ref of extractSkillReferences(source.body)) {
        if (ref === slug) return { reachable: true, skill: target };
        if (visited.has(ref) || visited.size >= SKILL_REFERENCE_MAX_VISITED) continue;
        visited.add(ref);
        // An unresolvable reference is a dead end, not an error: the body still
        // renders it, and fetching it reports not_found on its own request.
        const hop = pickBySlug(candidates, ref);
        if (hop) next.push(hop);
      }
    }

    if (next.length === 0) break;
    frontier = next;
  }

  return { reachable: false, reason: 'not_reachable' };
}
