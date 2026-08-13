/**
 * Skills MCP Handler Tests
 *
 * Tests each handler by mocking global.fetch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleListSkills, handleGetSkill } from './handlers.js';
import type { ServerContext } from '../common/types.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

process.env.REINS_API_URL = 'https://test.helm.mom';

const mockContext = {
  requestId: 'test-request-id',
  gatewayToken: 'test-gateway-token',
} as unknown as ServerContext;

function makeOkResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
    text: async () => JSON.stringify({ data }),
  };
}

/** Response whose JSON body is used verbatim, for envelopes beyond `{ data }`. */
function makeOkBody(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function makeErrorResponse(status: number, body: Record<string, unknown> = { error: 'Error' }) {
  return {
    ok: false,
    status,
    json: async () => body,
    text: async () => 'Error',
  };
}

const availableSkill = {
  slug: 'inbox-triage',
  name: 'Inbox Triage',
  description: 'Use when the user asks to clean up their inbox.',
  requiredServices: ['gmail'],
  available: true,
  missingServices: [],
};

const brokenSkill = {
  slug: 'weekly-report',
  name: 'Weekly Report',
  description: 'Use for a weekly status roll-up.',
  requiredServices: ['gmail', 'calendar'],
  available: false,
  missingServices: ['calendar'],
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe('handleListSkills', () => {
  it('calls the agent-skills endpoint with the gateway token', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse([availableSkill]));

    await handleListSkills({}, mockContext);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://test.helm.mom/api/agent-skills?include_unavailable=true');
    expect(options.headers['x-reins-agent-secret']).toBe('test-gateway-token');
  });

  it('passes include_unavailable=false through when asked', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse([]));

    await handleListSkills({ include_unavailable: false }, mockContext);

    expect(mockFetch.mock.calls[0][0]).toContain('include_unavailable=false');
  });

  it('surfaces unavailable skills with missing_services rather than dropping them', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse([availableSkill, brokenSkill]));

    const result = await handleListSkills({}, mockContext);

    expect(result.success).toBe(true);
    const skills = (result.data as any).skills;
    expect(skills).toHaveLength(2);

    const broken = skills.find((s: any) => s.slug === 'weekly-report');
    expect(broken.available).toBe(false);
    expect(broken.missing_services).toEqual(['calendar']);

    // An available skill carries no missing_services noise.
    const ok = skills.find((s: any) => s.slug === 'inbox-triage');
    expect(ok.available).toBe(true);
    expect(ok.missing_services).toBeUndefined();
  });

  it('explains where to add skills when the agent has none', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse([]));

    const result = await handleListSkills({}, mockContext);

    expect(result.success).toBe(true);
    expect((result.data as any).skills).toEqual([]);
    expect((result.data as any).note).toContain('dashboard');
  });

  it('reports API failures as a failed result rather than throwing', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(500));

    const result = await handleListSkills({}, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('500');
  });
});

describe('handleGetSkill', () => {
  it('fetches by slug and returns the instructions body', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({ ...availableSkill, body: '## Procedure\n1. Do it' }));

    const result = await handleGetSkill({ slug: 'inbox-triage' }, mockContext);

    expect(mockFetch.mock.calls[0][0]).toBe('https://test.helm.mom/api/agent-skills/inbox-triage');
    expect(result.success).toBe(true);
    expect((result.data as any).instructions).toBe('## Procedure\n1. Do it');
    expect((result.data as any).unavailable_services).toBeUndefined();
  });

  it('URL-encodes the slug so it cannot escape the path', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(404));

    await handleGetSkill({ slug: '../../api/agent-uploads' }, mockContext);

    const url = mockFetch.mock.calls[0][0];
    expect(url).toBe('https://test.helm.mom/api/agent-skills/..%2F..%2Fapi%2Fagent-uploads');
    expect(url).not.toContain('/../');
  });

  it('returns the body plus a blocker notice when a service is missing', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({ ...brokenSkill, body: '## Procedure' }));

    const result = await handleGetSkill({ slug: 'weekly-report' }, mockContext);

    expect(result.success).toBe(true);
    // The agent still gets the body so it can explain what it would have done.
    expect((result.data as any).instructions).toBe('## Procedure');
    expect((result.data as any).unavailable_services).toEqual(['calendar']);
    expect((result.data as any).blocked_notice).toContain('calendar');
    expect((result.data as any).blocked_notice).toContain('Do not improvise');
  });

  it('relays the setup notice when the backend reports one', async () => {
    // The agent cannot install skills itself, so the note has to hand off to
    // the user with the exact command.
    mockFetch.mockResolvedValueOnce(
      makeOkBody({
        data: [],
        setupNotice: 'Setup skills are not installed. Run `node scripts/install-skills.mjs`.',
      })
    );

    const result = await handleListSkills({}, mockContext);

    expect(result.success).toBe(true);
    expect((result.data as any).setup).toContain('install-skills');
  });

  it('surfaces per-skill update state', async () => {
    mockFetch.mockResolvedValueOnce(
      makeOkBody({
        data: [{
          slug: 'email-triage', name: 'Email Triage', description: 'Triage.',
          requiredServices: ['gmail'], available: true, missingServices: [],
          version: '1.0.0', latestVersion: '1.2.0', updateAvailable: true,
        }],
      })
    );

    const result = await handleListSkills({}, mockContext);

    const skill = (result.data as any).skills[0];
    expect(skill.version).toBe('1.0.0');
    expect(skill.update_available).toBe(true);
  });

  it('names the slug and points at skills_list on a 404', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(404));

    const result = await handleGetSkill({ slug: 'nope' }, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('nope');
    expect(result.error).toContain('skills_list');
  });

  it('tells the agent when a referenced skill exists but is not reachable', async () => {
    // "not assigned" and "does not exist" used to be the same bare 404, so the
    // agent could not tell a typo from a missing assignment.
    mockFetch.mockResolvedValueOnce(
      makeErrorResponse(404, {
        code: 'SKILL_NOT_REACHABLE',
        error: 'Skill "deep-research" exists but is not assigned to you and is not referenced by any skill you have.',
      })
    );

    const result = await handleGetSkill({ slug: 'deep-research' }, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('deep-research');
    expect(result.error).toContain('not assigned');
    // Nothing to fix by listing — it is an assignment problem, not a typo.
    expect(result.error).not.toContain('skills_list');
  });

  it('points at skills_list when the slug does not exist at all', async () => {
    mockFetch.mockResolvedValueOnce(
      makeErrorResponse(404, { code: 'SKILL_NOT_FOUND', error: 'No skill with slug "nope" exists.' })
    );

    const result = await handleGetSkill({ slug: 'nope' }, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('nope');
    expect(result.error).toContain('skills_list');
  });

  it('rejects a missing slug without calling the API', async () => {
    const result = await handleGetSkill({}, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('slug is required');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
