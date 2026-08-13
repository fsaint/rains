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

// ============================================================================
// Skill exposure: the assigned set, and nothing else
// ============================================================================

/**
 * Assignment is the exposure boundary.
 *
 * An earlier revision let a `{{skill:slug}}` reference grant access, making the
 * effective set the transitive closure of assignment. That is no longer true:
 * per-agent selection is meant to be exactly what the agent can reach, so a
 * reference now renders as a pointer and nothing more. A skill the owner has
 * but did not assign is reported as unassigned rather than served.
 */

export interface AddressableSkill {
  slug: string;
  /** null for system skills; a user id for skills that user owns. */
  userId: string | null;
}

export type SkillLookup<T> =
  | { reachable: true; skill: T }
  /** `not_found`: no such slug at all. `not_assigned`: exists, but not on this agent. */
  | { reachable: false; reason: 'not_found' | 'not_assigned' };

/**
 * Pick one skill for a slug.
 *
 * `slug` is unique among system skills and unique per user, but NOT globally
 * (backend/src/db/index.ts) — so a user skill can shadow a system one. The
 * owner's own skill wins: overriding a stock skill is the intuitive reading,
 * and picking deterministically is what stops the old `find()`-over-a-UNION
 * ambiguity from deciding it by row order.
 */
function pickBySlug<T extends AddressableSkill>(candidates: T[], slug: string): T | undefined {
  const matches = candidates.filter((c) => c.slug === slug);
  return matches.find((c) => c.userId !== null) ?? matches[0];
}

/**
 * Resolve `slug` against what this agent was actually assigned.
 *
 * `known` is only used to tell "you don't have it" from "it doesn't exist" —
 * it never widens what is served. Callers scope it to the owner's skills so the
 * distinction can't leak another user's slugs.
 */
export function resolveAssignedSkill<T extends AddressableSkill>(
  slug: string,
  assigned: T[],
  known: T[] = []
): SkillLookup<T> {
  const direct = pickBySlug(assigned, slug);
  if (direct) return { reachable: true, skill: direct };

  return { reachable: false, reason: pickBySlug(known, slug) ? 'not_assigned' : 'not_found' };
}

// ============================================================================
// Setup state: is the boot skill installed, and are skills current?
// ============================================================================

/**
 * The skill that carries first-run orientation. Its absence is what tells an
 * agent its skills have never been installed — and it cannot announce that
 * itself, since it is precisely what is missing, so the server says it instead.
 */
export const BOOT_SKILL_SLUG = 'helm-boot';

/** Command the user runs to install or update the skill set. */
const INSTALLER_COMMAND = 'node scripts/install-skills.mjs';

/**
 * Versions this build publishes, read from templates/skill-versions.json.
 *
 * templates/ is COPY'd into the backend image, so the file is present at
 * runtime — but a stripped build must degrade to "no updates known" rather
 * than crash, the same way seedSystemSkills tolerates a missing directory.
 */
export type SkillVersionManifest = Record<string, string>;

let _manifest: SkillVersionManifest | null = null;

export async function loadSkillVersionManifest(): Promise<SkillVersionManifest> {
  if (_manifest) return _manifest;
  try {
    const { readFile } = await import('fs/promises');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(here, '..', '..', '..', 'templates', 'skill-versions.json'), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    _manifest =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as SkillVersionManifest)
        : {};
  } catch {
    _manifest = {};
  }
  return _manifest;
}

/** Test seam — reset the cached manifest. */
export function __resetSkillVersionManifest() {
  _manifest = null;
}

/**
 * Compare an installed version against the published one.
 *
 * Inequality, not ordering: an unexpected version is worth surfacing whichever
 * direction it points, and semver parsing buys nothing here. An unversioned
 * skill, or one the manifest does not publish, is somebody's own work and is
 * never reported as stale.
 */
export function compareSkillVersion(
  slug: string,
  installedVersion: string | null | undefined,
  manifest: SkillVersionManifest
): { latestVersion: string | null; updateAvailable: boolean } {
  const latestVersion = manifest[slug] ?? null;
  if (!latestVersion || !installedVersion) return { latestVersion, updateAvailable: false };
  return { latestVersion, updateAvailable: installedVersion !== latestVersion };
}

/**
 * Patterns hermes-agent flags in MCP tool descriptions (`_scan_mcp_description`).
 *
 * Exported so the wording below is tested against them rather than reviewed by
 * eye. Warning-level upstream, but text that reads like an injection attempt in
 * the logs is text worth rewording.
 */
export const HERMES_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+a/i,
  /your\s+new\s+(task|role|instructions?)\s+(is|are)/i,
  /system\s*:\s*/i,
  /<\s*(system|human|assistant)\s*>/i,
  /do\s+not\s+(tell|inform|mention|reveal)/i,
  /(curl|wget|fetch)\s+https?:\/\//i,
];

/**
 * One line of setup state for the agent, or null when there is nothing to say.
 *
 * Shared by the skills_list description and the skills_list result note so the
 * two cannot drift. Phrased as reporting — the agent relays it to the user, who
 * is the only one who can act, since skills are installed over REST and not MCP.
 */
export function buildSetupNotice(
  installed: Array<{ slug: string; version?: string | null }>,
  manifest: SkillVersionManifest
): string | null {
  const hasBootSkill = installed.some((s) => s.slug === BOOT_SKILL_SLUG);

  if (!hasBootSkill) {
    return `Setup skills are not installed on this agent. The owner installs them by running \`${INSTALLER_COMMAND}\` from the reins repo; ask them to run it, then check again.`;
  }

  const stale = installed
    .filter((s) => compareSkillVersion(s.slug, s.version, manifest).updateAvailable)
    .map((s) => s.slug);

  if (stale.length === 0) return null;

  return `Newer versions are published for: ${stale.join(', ')}. The owner updates them by re-running \`${INSTALLER_COMMAND}\` from the reins repo.`;
}
