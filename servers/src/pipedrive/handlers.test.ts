/**
 * Pipedrive Handler Tests
 *
 * Focused on the HTTP verb used per resource (v1 update = PUT, leads/v2 = PATCH)
 * and custom-field passthrough. Pipedrive handlers call the global `fetch`
 * directly, so we stub it and inspect the request.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerContext } from '../common/types.js';
import {
  handleUpdateDeal,
  handleCreateDeal,
  handleUpdatePerson,
  handleUpdateOrganization,
  handleUpdateGoal,
  handleUpdateLead,
  handleUpdateProject,
  handleCreateActivity,
  handleConvertLead,
} from './handlers.js';

const context: ServerContext = {
  requestId: 'test-request-id',
  accessToken: 'test-token',
  // PipedriveContext extends ServerContext with companydomain
  ...( { companydomain: 'testco' } as Record<string, unknown> ),
};

function okResponse(data: unknown = { success: true }): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

function lastCall() {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: url as string, init: init as RequestInit };
}

describe('Pipedrive handlers — HTTP verbs', () => {
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('update_deal uses PUT against /api/v1/deals/{id} (regression: PATCH → "Unknown method.")', async () => {
    const res = await handleUpdateDeal({ deal_id: 94, value: 28800 }, context);
    expect(res.success).toBe(true);
    const { url, init } = lastCall();
    expect(init.method).toBe('PUT');
    expect(url).toBe('https://testco.pipedrive.com/api/v1/deals/94');
    expect(JSON.parse(init.body as string)).toMatchObject({ value: 28800 });
  });

  it.each([
    ['update_person', handleUpdatePerson, { person_id: 5, name: 'X' }, '/api/v1/persons/5'],
    ['update_organization', handleUpdateOrganization, { org_id: 7, name: 'Y' }, '/api/v1/organizations/7'],
    ['update_goal', handleUpdateGoal, { goal_id: 'g1' }, '/api/v1/goals/g1'],
  ])('%s uses PUT (v1)', async (_name, handler, args, path) => {
    await handler(args as Record<string, unknown>, context);
    const { url, init } = lastCall();
    expect(init.method).toBe('PUT');
    expect(url).toBe(`https://testco.pipedrive.com${path}`);
  });

  it('update_lead stays on PATCH (leads are PATCH even in v1)', async () => {
    await handleUpdateLead({ lead_id: 'uuid-1', title: 'Z' }, context);
    const { url, init } = lastCall();
    expect(init.method).toBe('PATCH');
    expect(url).toBe('https://testco.pipedrive.com/api/v1/leads/uuid-1');
  });

  it('update_project stays on PATCH (v2)', async () => {
    await handleUpdateProject({ project_id: 3, title: 'P' }, context);
    const { url, init } = lastCall();
    expect(init.method).toBe('PATCH');
    expect(url).toBe('https://testco.pipedrive.com/api/v2/projects/3');
  });

  it('convert_lead POSTs to /api/v1/leads/{id}/convert/deal', async () => {
    await handleConvertLead({ lead_id: 'uuid-9' }, context);
    const { url, init } = lastCall();
    expect(init.method).toBe('POST');
    expect(url).toBe('https://testco.pipedrive.com/api/v1/leads/uuid-9/convert/deal');
  });
});

describe('Pipedrive handlers — custom-field passthrough & links', () => {
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('update_deal spreads custom_fields as top-level v1 keys', async () => {
    const hash = '9058ca12000000000000000000000000000000ab';
    await handleUpdateDeal({ deal_id: 94, custom_fields: { [hash]: 4640 } }, context);
    const body = JSON.parse(lastCall().init.body as string);
    expect(body[hash]).toBe(4640);
  });

  it('create_deal spreads custom_fields and does not clobber standard fields', async () => {
    const hash = 'aaaa1111000000000000000000000000000000ff';
    await handleCreateDeal(
      { title: 'New', value: 100, custom_fields: { [hash]: 'qualified' } },
      context
    );
    const body = JSON.parse(lastCall().init.body as string);
    expect(body).toMatchObject({ title: 'New', value: 100, [hash]: 'qualified' });
  });

  it('create_activity accepts a lead_id link (UUID)', async () => {
    await handleCreateActivity(
      { subject: 'Call', type: 'call', lead_id: 'lead-uuid' },
      context
    );
    const body = JSON.parse(lastCall().init.body as string);
    expect(body.lead_id).toBe('lead-uuid');
  });
});
