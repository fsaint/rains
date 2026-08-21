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
  handleGetAuthoredSkill,
  handleCreateSkill,
  handleUpdateSkill,
  handleDeleteSkill,
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
    // Not /api/skills: that route resolves its caller from a session, which a
    // gateway token does not have, so it threw a 500 on every call. Regression
    // test — this assertion previously pinned the broken URL.
    expect(url).toBe('https://test.helm.mom/api/skill-library');
    expect((init.headers as Record<string, string>)['x-reins-agent-secret']).toBe('test-gateway-token');

    const skills = (result.data as any).skills;
    expect(skills[0].read_only).toBeUndefined();
    expect(skills[1].read_only).toBe(true);
  });

  it('surfaces a 403 when the skill-authoring service is not enabled', async () => {
    mockFetch.mockResolvedValueOnce(
      makeErrorResponse(403, {
        error: { code: 'SERVICE_NOT_ENABLED', message: 'The skill-authoring service is not enabled on this agent.' },
      })
    );

    const result = await handleListAuthoredSkills({}, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not enabled');
  });
});

/**
 * The reason the /api/skills bug was opaque: Fastify's default envelope puts the
 * generic status text in `error` and the real cause in `message`, so reading
 * `error` first reported "Internal Server Error" for every unexpected failure.
 */
describe('error surfacing', () => {
  it('prefers the app\'s own {error:{message}} over anything else', async () => {
    mockFetch.mockResolvedValueOnce(
      makeErrorResponse(409, { error: { code: 'DUPLICATE_SLUG', message: 'A skill with the slug "x" already exists' } })
    );

    const result = await handleListAuthoredSkills({}, mockContext);

    expect(result.error).toBe('A skill with the slug "x" already exists');
  });

  it('reports the Fastify message, not the generic "Internal Server Error"', async () => {
    mockFetch.mockResolvedValueOnce(
      makeErrorResponse(500, {
        statusCode: 500,
        error: 'Internal Server Error',
        message: "Cannot read properties of undefined (reading 'userId')",
      })
    );

    const result = await handleListAuthoredSkills({}, mockContext);

    expect(result.error).toBe("Cannot read properties of undefined (reading 'userId')");
    expect(result.error).not.toBe('Internal Server Error');
  });

  it('falls back to a bare string error when that is all there is', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(401, { error: 'Unauthorized' }));

    const result = await handleListAuthoredSkills({}, mockContext);

    expect(result.error).toBe('Unauthorized');
  });

  it('falls back to the caller\'s phrasing plus the status when the body is empty', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}), text: async () => '' });

    const result = await handleListAuthoredSkills({}, mockContext);

    expect(result.error).toBe('Could not list skills (HTTP 502)');
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

describe('handleGetAuthoredSkill', () => {
  /**
   * The read an author needs: any of the owner's skills, assigned or not, and
   * the body exactly as stored. The skills server's read is the wrong tool for
   * this — it serves only assigned skills and renders {{tool:…}} into the
   * reading agent's runtime names, which an author would then write back.
   */
  it('reads by id from the authoring library, not the assigned-skills route', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({
      id: 'sk-1', slug: 'inbox-triage', name: 'Inbox Triage',
      description: 'Triage mail', body: 'Call {{tool:gmail_search}}.',
      requiredServices: ['gmail'], isSystem: false,
    }));

    const result = await handleGetAuthoredSkill({ skill_id: 'sk-1' }, mockContext);

    expect(result.success).toBe(true);
    const { url, init } = lastCall();
    // /api/skill-library/:idOrSlug applies no assignment check; /api/agent-skills/:slug does.
    expect(url).toBe('https://test.helm.mom/api/skill-library/sk-1');
    expect(url).not.toContain('/agent-skills/');
    expect((init.headers as Record<string, string>)['x-reins-agent-secret']).toBe('test-gateway-token');
  });

  it('returns the body with its tokens intact', async () => {
    // The property the whole tool exists for. A rendered body written back
    // through skill_authoring_update would bake one runtime's tool names into
    // the stored skill and break it for the other.
    mockFetch.mockResolvedValueOnce(makeOkResponse({
      id: 'sk-1', slug: 'inbox-triage', name: 'Inbox Triage',
      description: 'Triage mail',
      body: 'Search with {{tool:gmail_search}} then see {{skill:filing}}.',
      requiredServices: [],
    }));

    const result = await handleGetAuthoredSkill({ skill_id: 'sk-1' }, mockContext);

    const data = result.data as { body: string };
    expect(data.body).toContain('{{tool:gmail_search}}');
    expect(data.body).toContain('{{skill:filing}}');
    expect(data.body).not.toContain('helm__');
  });

  it('accepts a slug, which is what {{skill:…}} references give you', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({
      id: 'sk-2', slug: 'filing', name: 'Filing', description: 'File things', body: '…',
    }));

    await handleGetAuthoredSkill({ skill_id: 'filing' }, mockContext);

    expect(lastCall().url).toBe('https://test.helm.mom/api/skill-library/filing');
  });

  it('marks a platform skill read-only, so an author learns it before the update fails', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({
      id: 'sk-sys', slug: 'sys', name: 'System', description: 'd', body: 'b',
      isSystem: true, readOnly: true,
    }));

    const result = await handleGetAuthoredSkill({ skill_id: 'sk-sys' }, mockContext);

    expect((result.data as { read_only?: boolean }).read_only).toBe(true);
  });

  it('omits read_only for a skill the author can edit', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({
      id: 'sk-1', slug: 's', name: 'S', description: 'd', body: 'b', readOnly: false,
    }));

    const result = await handleGetAuthoredSkill({ skill_id: 'sk-1' }, mockContext);

    expect(result.data as Record<string, unknown>).not.toHaveProperty('read_only');
  });

  it('requires an identifier rather than fetching everything', async () => {
    const result = await handleGetAuthoredSkill({}, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/skill_id is required/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('surfaces the backend message when the skill does not exist', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(404, {
      error: 'No skill with id or slug "nope" exists on this account.',
    }));

    const result = await handleGetAuthoredSkill({ skill_id: 'nope' }, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('nope');
  });
});


describe('scope forwarding', () => {
  /**
   * `scope` is validated here as well as in the backend, and not only for
   * latency: the approval is queued *before* the handler runs, so a typo'd scope
   * would otherwise cost the owner an approval prompt for a call destined to 400.
   */
  it('forwards scope:"system" on create', async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ id: 'stock', slug: 'stock', scope: 'system' }));

    await handleCreateSkill(
      { name: 'Stock', description: 'd', body: 'b', scope: 'system' },
      mockContext
    );

    expect(JSON.parse(lastCall().init.body as string).scope).toBe('system');
  });

  it('omits scope entirely for a user-scoped or unscoped create', async () => {
    for (const args of [
      { name: 'N', description: 'd', body: 'b', scope: 'user' },
      { name: 'N', description: 'd', body: 'b' },
    ]) {
      mockFetch.mockResolvedValue(makeOkResponse({ id: 'sk-1', slug: 'n' }));
      await handleCreateSkill(args, mockContext);
      expect(JSON.parse(lastCall().init.body as string)).not.toHaveProperty('scope');
    }
  });

  it('forwards scope:"system" on update', async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ id: 'stock', slug: 'stock' }));

    await handleUpdateSkill(
      { skill_id: 'stock', name: 'N', description: 'd', body: 'b', scope: 'system' },
      mockContext
    );

    expect(JSON.parse(lastCall().init.body as string).scope).toBe('system');
  });

  it('rejects an unrecognised scope without spending a round trip', async () => {
    const result = await handleCreateSkill(
      { name: 'N', description: 'd', body: 'b', scope: 'platform' },
      mockContext
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('scope must be');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('points a 404 at the scope argument rather than calling platform skills uneditable', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(404));

    const result = await handleUpdateSkill(
      { skill_id: 'stock', name: 'N', description: 'd', body: 'b' },
      mockContext
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('scope:"system"');
    expect(result.error).toContain('Helm admin');
  });
});

describe('handleDeleteSkill', () => {
  it('requires a skill_id', async () => {
    const result = await handleDeleteSkill({}, mockContext);

    expect(result.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('DELETEs the id endpoint, url-encoding the id', async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ id: 'a/b', slug: 's', deleted: true }));

    await handleDeleteSkill({ skill_id: 'a/b' }, mockContext);

    const { url, init } = lastCall();
    expect(init.method).toBe('DELETE');
    expect(url).toBe('https://test.helm.mom/api/agent-skills/id/a%2Fb');
    expect((init.headers as Record<string, string>)['x-reins-agent-secret']).toBe('test-gateway-token');
  });

  it('sends scope in the query string, not a body — DELETE bodies are not parsed', async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ id: 'stock', slug: 'stock', deleted: true }));

    await handleDeleteSkill({ skill_id: 'stock', scope: 'system' }, mockContext);

    const { url, init } = lastCall();
    expect(url).toContain('?scope=system');
    expect(init.body).toBeUndefined();
  });

  it('warns that a deleted platform skill returns if a template still ships for it', async () => {
    mockFetch.mockResolvedValue(
      makeOkResponse({ id: 'stock', slug: 'stock', deleted: true, reseeds: true })
    );

    const result = await handleDeleteSkill({ skill_id: 'stock', scope: 'system' }, mockContext);

    expect(result.success).toBe(true);
    expect((result.data as { note?: string }).note).toContain('re-created from the repo templates');
  });

  it('omits the re-seed note for a skill that cannot come back', async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ id: 'sk-1', slug: 's', deleted: true }));

    const result = await handleDeleteSkill({ skill_id: 'sk-1' }, mockContext);

    expect(result.data as Record<string, unknown>).not.toHaveProperty('note');
  });
});

describe('per-caller read_only', () => {
  it('reports a platform skill as editable for an admin owner, while still naming its scope', async () => {
    // read_only answers "may *you* write this"; scope answers "how is it
    // addressed". They stopped being the same question once an admin owner's
    // architect could write platform skills.
    mockFetch.mockResolvedValue(
      makeOkResponse({
        id: 'stock', slug: 'stock', name: 'Stock', description: 'd', body: 'b',
        isSystem: true, readOnly: false,
      })
    );

    const result = await handleGetAuthoredSkill({ skill_id: 'stock' }, mockContext);

    const data = result.data as Record<string, unknown>;
    expect(data.scope).toBe('system');
    expect(data).not.toHaveProperty('read_only');
  });

  it('falls back to isSystem when the backend does not send readOnly', async () => {
    // Keeps an un-upgraded backend reporting platform skills as read-only rather
    // than silently inviting a write that will be refused.
    mockFetch.mockResolvedValue(
      makeOkResponse([
        { id: 'stock', slug: 'stock', name: 'S', description: 'd', requiredServices: [], isSystem: true },
      ])
    );

    const result = await handleListAuthoredSkills({}, mockContext);
    const skills = (result.data as { skills: Array<Record<string, unknown>> }).skills;

    expect(skills[0].read_only).toBe(true);
    expect(skills[0].scope).toBe('system');
  });
});
