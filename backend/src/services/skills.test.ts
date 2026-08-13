/**
 * Skill availability resolver tests.
 *
 * The behaviour under test is the product requirement: a skill is only usable
 * when every service it declares is enabled AND credentialed on that agent —
 * and losing a service must never delete the assignment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetAgentInstances } = vi.hoisted(() => ({
  mockGetAgentInstances: vi.fn(),
}));

vi.mock('./permissions.js', () => ({
  getAgentInstances: mockGetAgentInstances,
}));

const {
  parseRequiredServices,
  getSatisfiedServices,
  missingServices,
  resolveAvailability,
  resolveAssignedSkill,
  compareSkillVersion,
  buildSetupNotice,
  BOOT_SKILL_SLUG,
  HERMES_INJECTION_PATTERNS,
} = await import('./skills.js');

/** Minimal ServiceInstance shape — only the fields the resolver reads. */
function instance(serviceType: string, enabled = true, credentialStatus = 'connected') {
  return { serviceType, enabled, credentialStatus } as any;
}

beforeEach(() => {
  mockGetAgentInstances.mockReset();
});

describe('parseRequiredServices', () => {
  it('parses a JSON array string', () => {
    expect(parseRequiredServices('["gmail","calendar"]')).toEqual(['gmail', 'calendar']);
  });

  it('returns an empty array for null, empty, or malformed values', () => {
    expect(parseRequiredServices(null)).toEqual([]);
    expect(parseRequiredServices('')).toEqual([]);
    expect(parseRequiredServices('not json')).toEqual([]);
    expect(parseRequiredServices('{"a":1}')).toEqual([]);
  });

  it('accepts an already-parsed array and drops non-strings', () => {
    expect(parseRequiredServices(['gmail', 42, null])).toEqual(['gmail']);
  });
});

describe('getSatisfiedServices', () => {
  it('counts a service only when enabled and connected', async () => {
    mockGetAgentInstances.mockResolvedValueOnce([
      instance('gmail', true, 'connected'),
      instance('calendar', false, 'connected'), // disabled
      instance('drive', true, 'expired'),
      instance('github', true, 'missing'),
      instance('notion', true, 'not_linked'),
    ]);

    const satisfied = await getSatisfiedServices('agent-1');

    expect([...satisfied]).toEqual(['gmail']);
  });

  it('treats no-auth services as connected (getAgentInstances short-circuits them)', async () => {
    // memory/skills/browser have auth.required === false, so permissions.ts
    // reports them as 'connected' without a credential.
    mockGetAgentInstances.mockResolvedValueOnce([
      instance('memory', true, 'connected'),
      instance('skills', true, 'connected'),
    ]);

    const satisfied = await getSatisfiedServices('agent-1');

    expect(satisfied.has('memory')).toBe(true);
    expect(satisfied.has('skills')).toBe(true);
  });
});

describe('missingServices', () => {
  it('returns nothing when every requirement is satisfied', () => {
    expect(missingServices(['gmail'], new Set(['gmail', 'drive']))).toEqual([]);
  });

  it('returns only the unsatisfied ones, preserving order', () => {
    expect(missingServices(['gmail', 'calendar', 'drive'], new Set(['calendar']))).toEqual([
      'gmail',
      'drive',
    ]);
  });

  it('treats a skill with no requirements as always usable', () => {
    expect(missingServices([], new Set())).toEqual([]);
  });
});

describe('resolveAvailability', () => {
  it('resolves many skills from a single instance lookup', async () => {
    mockGetAgentInstances.mockResolvedValueOnce([instance('gmail')]);

    const result = await resolveAvailability('agent-1', [
      { id: 'a', requiredServices: ['gmail'] },
      { id: 'b', requiredServices: ['gmail', 'calendar'] },
      { id: 'c', requiredServices: [] },
    ]);

    expect(result.get('a')).toEqual({ available: true, missingServices: [] });
    expect(result.get('b')).toEqual({ available: false, missingServices: ['calendar'] });
    expect(result.get('c')).toEqual({ available: true, missingServices: [] });

    // Instance lookup is expensive, so it must not run per skill.
    expect(mockGetAgentInstances).toHaveBeenCalledTimes(1);
  });

  it('marks a skill unavailable when its service is later disconnected, without removing it', async () => {
    // The assignment is unchanged — the caller still passes the skill in, and
    // it still comes back in the map. Only `available` flips.
    mockGetAgentInstances.mockResolvedValueOnce([instance('gmail', true, 'expired')]);

    const result = await resolveAvailability('agent-1', [{ id: 'a', requiredServices: ['gmail'] }]);

    expect(result.has('a')).toBe(true);
    expect(result.get('a')).toEqual({ available: false, missingServices: ['gmail'] });
  });
});

// ============================================================================
// Exposure boundary: the assigned set, and nothing else
// ============================================================================

/**
 * Per-agent selection is meant to be exactly what the agent can reach. An
 * earlier revision let a {{skill:...}} reference grant access; these pin that
 * it no longer does, and that the two "you can't have it" answers stay
 * distinguishable.
 */
function skill(slug: string, body = '', userId: string | null = null) {
  return { id: `id-${slug}${userId ?? ''}`, slug, userId, body };
}

describe('resolveAssignedSkill', () => {
  it('returns an assigned skill', () => {
    const a = skill('a');
    const result = resolveAssignedSkill('a', [a]);
    expect(result.reachable).toBe(true);
    expect(result.reachable && result.skill.slug).toBe('a');
  });

  it('refuses a skill that is merely referenced by an assigned one', () => {
    // The body still renders the pointer; it just does not open the door.
    const a = skill('a', 'see {{skill:b}}');
    const b = skill('b');
    const result = resolveAssignedSkill('b', [a], [a, b]);
    expect(result.reachable).toBe(false);
    expect(result.reachable === false && result.reason).toBe('not_assigned');
  });

  it('distinguishes not-assigned from does-not-exist', () => {
    // Different fixes: one is an assignment, the other is a typo.
    const a = skill('a');
    const b = skill('b');

    const unassigned = resolveAssignedSkill('b', [a], [a, b]);
    expect(unassigned.reachable).toBe(false);
    expect(unassigned.reachable === false && unassigned.reason).toBe('not_assigned');

    const missing = resolveAssignedSkill('ghost', [a], [a, b]);
    expect(missing.reachable).toBe(false);
    expect(missing.reachable === false && missing.reason).toBe('not_found');
  });

  it('reports an unknown slug as not found when nothing is known', () => {
    const result = resolveAssignedSkill('anything', []);
    expect(result.reachable).toBe(false);
    expect(result.reachable === false && result.reason).toBe('not_found');
  });

  it("prefers the owner's own skill over a system skill of the same slug", () => {
    // slug is unique per-user and among system skills, but not globally, so a
    // user skill can shadow a stock one. Resolution must be deterministic.
    const system = skill('shared', 'system body', null);
    const owned = skill('shared', 'owned body', 'user-1');
    const result = resolveAssignedSkill('shared', [system, owned]);
    expect(result.reachable).toBe(true);
    expect(result.reachable && result.skill.body).toBe('owned body');
  });
});

// ============================================================================
// Version comparison and the setup notice
// ============================================================================

describe('compareSkillVersion', () => {
  const manifest = { 'email-triage': '1.2.0', 'helm-boot': '1.0.0' };

  it('reports an update when the installed version differs from published', () => {
    expect(compareSkillVersion('email-triage', '1.0.0', manifest)).toEqual({
      latestVersion: '1.2.0',
      updateAvailable: true,
    });
  });

  it('reports no update when they match', () => {
    expect(compareSkillVersion('email-triage', '1.2.0', manifest).updateAvailable).toBe(false);
  });

  it('never reports an update for an unversioned skill', () => {
    // A hand-authored dashboard skill has no version and is not the
    // installer's to manage — nagging about it would be noise.
    expect(compareSkillVersion('email-triage', null, manifest).updateAvailable).toBe(false);
  });

  it('never reports an update for a slug the manifest does not publish', () => {
    expect(compareSkillVersion('someones-own-skill', '3.0.0', manifest)).toEqual({
      latestVersion: null,
      updateAvailable: false,
    });
  });
});

describe('buildSetupNotice', () => {
  it('offers the installer when the boot skill is absent', () => {
    const notice = buildSetupNotice([{ slug: 'email-triage', version: '1.2.0' }], {});
    expect(notice).not.toBeNull();
    expect(notice).toContain('install-skills');
  });

  it('says nothing once the boot skill is installed and current', () => {
    const notice = buildSetupNotice(
      [{ slug: BOOT_SKILL_SLUG, version: '1.0.0' }],
      { [BOOT_SKILL_SLUG]: '1.0.0' }
    );
    expect(notice).toBeNull();
  });

  it('names the outdated skills when the boot skill is present', () => {
    const notice = buildSetupNotice(
      [
        { slug: BOOT_SKILL_SLUG, version: '1.0.0' },
        { slug: 'email-triage', version: '1.0.0' },
      ],
      { [BOOT_SKILL_SLUG]: '1.0.0', 'email-triage': '1.2.0' }
    );
    expect(notice).toContain('email-triage');
    expect(notice).not.toContain(BOOT_SKILL_SLUG);
  });

  it('speaks up for an agent with no skills at all', () => {
    // This is the case that must not stay silent: with zero skills there is no
    // skill that could carry the instruction, so the server has to.
    expect(buildSetupNotice([], {})).toContain('install-skills');
  });

  it('avoids every pattern the Hermes description scanner flags', () => {
    // hermes-agent scans MCP tool descriptions for prompt-injection patterns
    // and logs a warning on a hit. This text ships inside the skills_list
    // description, so it must read as plain reporting.
    const samples = [
      buildSetupNotice([], {}),
      buildSetupNotice([{ slug: 'a', version: '1.0.0' }], { a: '2.0.0' }),
    ].filter((t): t is string => typeof t === 'string');

    expect(samples.length).toBeGreaterThan(0);
    for (const text of samples) {
      for (const pattern of HERMES_INJECTION_PATTERNS) {
        expect(pattern.test(text), `matched ${pattern}`).toBe(false);
      }
    }
  });
});
