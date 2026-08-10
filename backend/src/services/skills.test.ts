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

const { parseRequiredServices, getSatisfiedServices, missingServices, resolveAvailability } =
  await import('./skills.js');

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
