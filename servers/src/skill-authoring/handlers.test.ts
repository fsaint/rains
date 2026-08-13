/**
 * Skill Authoring handler tests.
 *
 * These handlers hold no authorization logic — the backend scopes every write
 * to the calling agent's owner. What they must get right is the wire contract:
 * the gateway token on every call, the right method and endpoint, and refusing
 * to send a partial update that would blank a skill.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerContext } from '../common/types.js';
import {
  handleListAuthoredSkills,
  handleCreateSkill,
  handleUpdateSkill,
  handleAssignSkill,
  handleUnassignSkill,
} from './handlers.js';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;
process.env.REINS_API_URL = 'https://test.helm.mom';

const mockContext = {
  requestId: 'test-request-id',
  gatewayToken: 'test-gateway-token',
} as unknown as ServerContext;

function makeOkResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ data }), text: async () => '' };
}

function makeErrorResponse(status: number, body: Record<string, unknown> = { error: 'Error' }) {
  return { ok: false, status, json: async () => body, text: async () => 'Error' };
}

/** The last fetch call, as [url, init]. */
function lastCall() {
  const call = mockFetch.mock.calls.at(-1) as [string, RequestInit];
  return { url: call[0], init: call[1] };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('handleListAuthoredSkills', () => {
  it('sends the gateway token and flags platform skills read-only', async () => {
    mockFetch.mockResolvedValueOnce(
      makeOkResponse([
        { id: 'sk-1', slug: 'triage', name: 'Triage', description: 'x', requiredServices: [] },
        { id: 'sk-2', slug: 'stock', name: 'Stock', description: 'y', requiredServices: [], isSystem: true },
      ])
    );

    const result = await handleListAuthoredSkills({}, mockContext);

    const { url, init } = lastCall();
    expect(url).toBe('https://test.helm.mom/api/skills');
    expect((init.headers as Record<string, string>)['x-reins-agent-secret']).toBe('test-gateway-token');

    const skills = (result.data as any).skills;
    expect(skills[0].read_only).toBeUndefined();
    expect(skills[1].read_only).toBe(true);
  });
});

describe('handleCreateSkill', () => {
  it('posts to the agent-audience endpoint and points at assignment next', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({ id: 'sk-9', slug: 'new-skill' }));

    const result = await handleCreateSkill(
      { name: 'New Skill', description: 'When to use.', body: '## Steps', requires: ['gmail'] },
      mockContext
    );

    const { url, init } = lastCall();
    expect(url).toBe('https://test.helm.mom/api/agent-skills');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({
      name: 'New Skill',
      requiredServices: ['gmail'],
    });
    // A created skill does nothing until attached — say so rather than let the
    // agent report success and stop.
    expect((result.data as any).next_step).toContain('skill_authoring_assign');
  });

  it('refuses a skill with no description without calling the API', async () => {
    const result = await handleCreateSkill({ name: 'X', body: 'y' }, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('description');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('surfaces a duplicate slug rather than a bare status', async () => {
    mockFetch.mockResolvedValueOnce(
      makeErrorResponse(409, { error: { code: 'DUPLICATE_SLUG', message: 'A skill with the slug "x" already exists' } })
    );

    const result = await handleCreateSkill(
      { name: 'X', description: 'd', body: 'b' },
      mockContext
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
  });
});

describe('handleUpdateSkill', () => {
  it('puts the full replacement body', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({ id: 'sk-1', slug: 'triage' }));

    await handleUpdateSkill(
      { skill_id: 'sk-1', name: 'Triage', description: 'd', body: 'new body' },
      mockContext
    );

    const { url, init } = lastCall();
    expect(url).toBe('https://test.helm.mom/api/agent-skills/id/sk-1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string).body).toBe('new body');
  });

  it('refuses a partial update, which would blank the omitted fields', async () => {
    const result = await handleUpdateSkill({ skill_id: 'sk-1', body: 'only the body' }, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('replaces the whole skill');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('explains a 404 as an ownership boundary, not a missing row', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(404));

    const result = await handleUpdateSkill(
      { skill_id: 'sk-other', name: 'n', description: 'd', body: 'b' },
      mockContext
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('belongs to your owner');
  });
});

describe('assignment', () => {
  it('attaches by posting attached=true', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({ agentId: 'agent-2', skillId: 'sk-1', attached: true }));

    await handleAssignSkill({ agent_id: 'agent-2', skill_id: 'sk-1' }, mockContext);

    const { url, init } = lastCall();
    expect(url).toBe('https://test.helm.mom/api/agent-skills/assign/agent-2');
    expect(JSON.parse(init.body as string)).toEqual({ skillId: 'sk-1', attached: true });
  });

  it('detaches by posting attached=false', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({ agentId: 'agent-2', skillId: 'sk-1', attached: false }));

    await handleUnassignSkill({ agent_id: 'agent-2', skill_id: 'sk-1' }, mockContext);

    expect(JSON.parse(lastCall().init.body as string)).toEqual({ skillId: 'sk-1', attached: false });
  });

  it('reports the missing service when the target agent cannot support the skill', async () => {
    mockFetch.mockResolvedValueOnce(
      makeErrorResponse(409, {
        error: { code: 'MISSING_SERVICES', message: '"Triage" needs gmail, not connected to that agent' },
      })
    );

    const result = await handleAssignSkill({ agent_id: 'agent-2', skill_id: 'sk-1' }, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('gmail');
  });

  it('requires both ids before calling the API', async () => {
    expect((await handleAssignSkill({ skill_id: 'sk-1' }, mockContext)).success).toBe(false);
    expect((await handleAssignSkill({ agent_id: 'agent-2' }, mockContext)).success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
