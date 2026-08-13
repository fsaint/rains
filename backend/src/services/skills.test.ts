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
  resolveReachableSkill,
  SKILL_REFERENCE_MAX_DEPTH,
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
// Reachability through {{skill:...}} references
// ============================================================================

/**
 * A reference grants access, and there is no stored edge set — the graph is
 * derived from bodies at request time. These cover the shape of that walk and,
 * more importantly, its limits: a reference must never reach another user's
 * skill, and a cyclic or deep graph must not turn one fetch into a runaway.
 */
function skill(slug: string, body = '', userId: string | null = null) {
  return { id: `id-${slug}${userId ?? ''}`, slug, userId, body };
}

describe('resolveReachableSkill', () => {
  it('returns an assigned skill directly', () => {
    const a = skill('a');
    const result = resolveReachableSkill('a', [a], [a]);
    expect(result.reachable).toBe(true);
    expect(result.reachable && result.skill.slug).toBe('a');
  });

  it('reaches a skill referenced by an assigned one', () => {
    const a = skill('a', 'see {{skill:b}}');
    const b = skill('b');
    const result = resolveReachableSkill('b', [a], [a, b]);
    expect(result.reachable).toBe(true);
  });

  it('reaches transitively through a chain', () => {
    const a = skill('a', '{{skill:b}}');
    const b = skill('b', '{{skill:c}}');
    const c = skill('c');
    expect(resolveReachableSkill('c', [a], [a, b, c]).reachable).toBe(true);
  });

  it('reports an existing but unreferenced skill as not reachable, not missing', () => {
    const a = skill('a');
    const b = skill('b');
    const result = resolveReachableSkill('b', [a], [a, b]);
    expect(result.reachable).toBe(false);
    expect(result.reachable === false && result.reason).toBe('not_reachable');
  });

  it('reports an unknown slug as not found', () => {
    const a = skill('a', '{{skill:ghost}}');
    const result = resolveReachableSkill('ghost', [a], [a]);
    expect(result.reachable).toBe(false);
    expect(result.reachable === false && result.reason).toBe('not_found');
  });

  it('terminates on a reference cycle', () => {
    const a = skill('a', '{{skill:b}}');
    const b = skill('b', '{{skill:a}}');
    const target = skill('z');
    const result = resolveReachableSkill('z', [a], [a, b, target]);
    expect(result.reachable).toBe(false);
  });

  it('stops at the depth cap', () => {
    // chain a -> s0 -> s1 -> ... longer than the cap
    const depth = SKILL_REFERENCE_MAX_DEPTH + 3;
    const chain = Array.from({ length: depth }, (_, i) =>
      skill(`s${i}`, i < depth - 1 ? `{{skill:s${i + 1}}}` : '')
    );
    const entry = skill('a', '{{skill:s0}}');
    const candidates = [entry, ...chain];

    expect(resolveReachableSkill('s0', [entry], candidates).reachable).toBe(true);
    expect(resolveReachableSkill(`s${depth - 1}`, [entry], candidates).reachable).toBe(false);
  });

  it('never reaches another user\'s skill', () => {
    // The candidate set is scoped by the caller, so a foreign skill simply is
    // not a candidate — even when an assigned body names its slug.
    const mine = skill('mine', '{{skill:theirs}}', 'user-1');
    const result = resolveReachableSkill('theirs', [mine], [mine]);
    expect(result.reachable).toBe(false);
    expect(result.reachable === false && result.reason).toBe('not_found');
  });

  it('prefers the owner\'s own skill over a system skill of the same slug', () => {
    // slug is unique per-user and among system skills, but not globally, so a
    // user skill can shadow a stock one. Resolution must be deterministic.
    const system = skill('shared', 'system body', null);
    const owned = skill('shared', 'owned body', 'user-1');
    const entry = skill('entry', '{{skill:shared}}');
    const result = resolveReachableSkill('shared', [entry], [entry, system, owned]);
    expect(result.reachable).toBe(true);
    expect(result.reachable && result.skill.body).toBe('owned body');
  });
});
