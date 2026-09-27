/**
 * Roles and profiles: the write half of the Hermeneutix server.
 *
 * Two properties matter more than the request shapes. A pinned agent must
 * never reach a project it was not scoped to — these are writes on a real
 * person's record, so the check fails closed. And the upsert must send only
 * the fields the caller named, because the API treats an omitted field as
 * "unchanged" and an empty string as "clear this".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerContext } from '../common/types.js';
import {
  handleListRoles,
  handleGetRole,
  handleSetRole,
  handleRemoveFromProject,
  handleUpdateProfile,
  handleSetCoachingNotes,
} from './handlers.js';

const PROJECT = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const PROFILE = '33333333-3333-3333-3333-333333333333';

const ctx = (over: Partial<ServerContext> = {}): ServerContext => ({
  requestId: 'req-1',
  accessToken: 'tok',
  ...over,
});

const pinned = (id = PROJECT) => ctx({ instanceConfig: { projectId: id, projectName: 'Acme' } });

/** Record every fetch, answering with `body` at `status`. */
function api(status = 200, body: unknown = { success: true }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  }));
  return calls;
}

const bodyOf = (call: { init: RequestInit }) => JSON.parse(String(call.init.body ?? '{}'));

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('hermeneutix_list_roles', () => {
  it('lists the roles for the project', async () => {
    const calls = api(200, { success: true, roles: [{ id: 'r1', profile: { id: PROFILE, name: 'Ana' }, name: 'Lead' }] });

    const result = await handleListRoles({ project_id: PROJECT }, ctx());

    expect(result.success).toBe(true);
    expect(calls[0].url).toContain(`/v1/projects/${PROJECT}/roles/`);
  });

  it('uses the pinned project without being told', async () => {
    const calls = api(200, { success: true, roles: [] });

    await handleListRoles({}, pinned());

    expect(calls[0].url).toContain(`/v1/projects/${PROJECT}/roles/`);
  });

  it('refuses another project when pinned', async () => {
    const calls = api();

    const result = await handleListRoles({ project_id: OTHER }, pinned());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/limited to/i);
    expect(calls).toHaveLength(0);
  });
});

describe('hermeneutix_get_role', () => {
  it('reads one person\'s role', async () => {
    const calls = api(200, { success: true, role: { name: 'Superintendent' } });

    const result = await handleGetRole({ project_id: PROJECT, profile_id: PROFILE }, ctx());

    expect(result.success).toBe(true);
    expect(calls[0].url).toContain(`/v1/projects/${PROJECT}/roles/${PROFILE}/`);
  });

  /** 404 means "not on this project", which is an answer, not a failure to explain away. */
  it('says plainly when the person has no role there', async () => {
    api(404, { detail: 'Not found' });

    const result = await handleGetRole({ project_id: PROJECT, profile_id: PROFILE }, ctx());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no role|not a member/i);
  });

  it('requires a profile_id', async () => {
    const calls = api();
    const result = await handleGetRole({ project_id: PROJECT }, ctx());
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('hermeneutix_set_role', () => {
  it('PUTs only the fields the caller named', async () => {
    const calls = api(200, { success: true, role: {} });

    await handleSetRole({ project_id: PROJECT, profile_id: PROFILE, role_description: 'Runs the site' }, ctx());

    expect(calls[0].init.method).toBe('PUT');
    expect(calls[0].url).toContain(`/v1/projects/${PROJECT}/roles/${PROFILE}/`);
    // name and negative_prompt were not named, so they must not be sent —
    // the API leaves out fields unchanged, and sending them would wipe them.
    expect(bodyOf(calls[0])).toEqual({ role_description: 'Runs the site' });
  });

  it('passes an empty string through, because that is how a field is cleared', async () => {
    const calls = api(200, { success: true, role: {} });

    await handleSetRole({ project_id: PROJECT, profile_id: PROFILE, negative_prompt: '' }, ctx());

    expect(bodyOf(calls[0])).toEqual({ negative_prompt: '' });
  });

  it('sends every field when all three are given', async () => {
    const calls = api(201, { success: true, role: {} });

    const result = await handleSetRole(
      { project_id: PROJECT, profile_id: PROFILE, name: 'Superintendent', role_description: 'Site', negative_prompt: 'Not budget' },
      ctx()
    );

    expect(result.success).toBe(true);
    expect(bodyOf(calls[0])).toEqual({
      name: 'Superintendent', role_description: 'Site', negative_prompt: 'Not budget',
    });
  });

  it('refuses a write to another project when pinned', async () => {
    const calls = api();

    const result = await handleSetRole({ project_id: OTHER, profile_id: PROFILE, name: 'X' }, pinned());

    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('refuses a call that would change nothing', async () => {
    const calls = api();

    const result = await handleSetRole({ project_id: PROJECT, profile_id: PROFILE }, ctx());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/at least one/i);
    expect(calls).toHaveLength(0);
  });
});

describe('hermeneutix_remove_from_project', () => {
  it('DELETEs the role and reports the empty success', async () => {
    const calls = api(204);

    const result = await handleRemoveFromProject({ project_id: PROJECT, profile_id: PROFILE }, ctx());

    expect(result.success).toBe(true);
    expect(calls[0].init.method).toBe('DELETE');
  });

  it('refuses another project when pinned', async () => {
    const calls = api(204);

    const result = await handleRemoveFromProject({ project_id: OTHER, profile_id: PROFILE }, pinned());

    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('hermeneutix_update_profile', () => {
  it('POSTs the name, which the API requires', async () => {
    const calls = api(200, { success: true });

    await handleUpdateProfile({ profile_id: PROFILE, name: 'Ana Ruiz' }, ctx());

    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].url).toContain(`/profiles/${PROFILE}/update/`);
    expect(bodyOf(calls[0])).toEqual({ name: 'Ana Ruiz' });
  });

  it('includes the email when given', async () => {
    const calls = api(200, { success: true });

    await handleUpdateProfile({ profile_id: PROFILE, name: 'Ana Ruiz', email: 'ana@acme.com' }, ctx());

    expect(bodyOf(calls[0])).toEqual({ name: 'Ana Ruiz', email: 'ana@acme.com' });
  });

  it('requires a name', async () => {
    const calls = api();
    const result = await handleUpdateProfile({ profile_id: PROFILE, email: 'a@b.c' }, ctx());
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('hermeneutix_set_coaching_notes', () => {
  it('POSTs the notes', async () => {
    const calls = api(200, { success: true });

    await handleSetCoachingNotes({ profile_id: PROFILE, coaching_notes: 'Prefers written follow-ups.' }, ctx());

    expect(calls[0].url).toContain(`/profiles/${PROFILE}/coaching-notes/`);
    expect(bodyOf(calls[0])).toEqual({ coaching_notes: 'Prefers written follow-ups.' });
  });

  it('surfaces an API refusal rather than claiming success', async () => {
    api(403, { error: 'You do not have editor permission' });

    const result = await handleSetCoachingNotes({ profile_id: PROFILE, coaching_notes: 'x' }, ctx());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/403|permission/i);
  });
});
