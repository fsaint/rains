/**
 * Tests for the skill management endpoints.
 *
 * These exercise the real `apiRoutes` plugin through `app.inject`, because the
 * properties under test are the ones a reimplementation would get wrong: the
 * ownership guard (404 rather than 403, since an id is not an authorization
 * boundary), the admin gate on system skills, service-dependency validation,
 * and the split between the session audience and the gateway-token audience.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

const {
  mockExecute,
  mockGetSession,
  mockRequireAdmin,
  mockResolveAvailability,
} = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockGetSession: vi.fn(),
  mockRequireAdmin: vi.fn(),
  mockResolveAvailability: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  client: { execute: mockExecute },
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

vi.mock('../auth/index.js', () => ({
  getSession: mockGetSession,
  requireAdmin: mockRequireAdmin,
  createMagicLinkToken: vi.fn(),
  verifyMagicLinkToken: vi.fn(),
}));

vi.mock('../services/skills.js', async () => {
  const actual = await vi.importActual<typeof import('../services/skills.js')>('../services/skills.js');
  return { ...actual, resolveAvailability: mockResolveAvailability };
});

// The route module reads validServiceTypes from this registry at startup.
vi.mock('@reins/servers', () => ({
  serviceDefinitions: [
    { type: 'gmail', name: 'Gmail' },
    { type: 'calendar', name: 'Calendar' },
    { type: 'skills', name: 'Skills' },
  ],
}));

vi.mock('../approvals/queue.js', () => ({
  MAX_REVISIONS: 3,
  approvalQueue: {
    requestChanges: vi.fn(), approve: vi.fn(), reject: vi.fn(), get: vi.fn(),
    submit: vi.fn(), listPending: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('../audit/logger.js', () => ({
  auditLogger: {
    log: vi.fn().mockResolvedValue(1),
    logApproval: vi.fn().mockResolvedValue(1),
    logToolCall: vi.fn().mockResolvedValue(1),
    logAgentEvent: vi.fn().mockResolvedValue(1),
    query: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('../config/index.js', () => ({
  config: {
    dashboardUrl: 'http://localhost:5173',
    publicUrl: 'http://localhost:3000',
    nodeEnv: 'test',
    encryptionKey: '0'.repeat(64),
  },
}));
vi.mock('../policy/engine.js', () => ({ policyEngine: {} }));
vi.mock('../credentials/vault.js', () => ({ credentialVault: {} }));
vi.mock('../mcp/proxy.js', () => ({ mcpProxy: {} }));
vi.mock('../mcp/server-manager.js', () => ({ serverManager: {} }));
vi.mock('../notifications/apns.js', () => ({ apnsService: {} }));
vi.mock('../notifications/telegram.js', () => ({ telegramNotifier: {} }));
vi.mock('../mcp/agent-endpoint.js', () => ({ handleMCPRequest: vi.fn() }));
vi.mock('../analytics/posthog.js', () => ({ getPostHog: () => null }));
vi.mock('../services/email.js', () => ({ sendReauthEmail: vi.fn() }));
vi.mock('../services/agent-backup.js', () => ({
  performBackup: vi.fn(), listBackups: vi.fn(), getBackup: vi.fn(), restoreBackup: vi.fn(),
}));
vi.mock('../services/agent-uploads.js', () => ({
  createUpload: vi.fn(), getUpload: vi.fn(), MAX_UPLOAD_BYTES: 1024,
}));
vi.mock('../services/token-monitor.js', () => ({ isCodexTokenExpired: vi.fn() }));
vi.mock('../services/agent-bot-relay.js', () => ({
  forwardToOpenclaw: vi.fn(), handleMyChatMember: vi.fn(),
}));
vi.mock('../services/memory.js', () => ({
  parseWikilinks: vi.fn(), updateLinkIndex: vi.fn(), ensureMemoryRoot: vi.fn(),
  getDreamManifest: vi.fn(), setEntryParent: vi.fn(),
}));
vi.mock('../providers/index.js', () => ({}));
vi.mock('../services/model-router.js', () => ({
  listModelConfigs: vi.fn(), upsertModelConfig: vi.fn(), deleteModelConfig: vi.fn(),
}));

import { apiRoutes } from './routes.js';

const empty = { rows: [], rowsAffected: 0, columns: [] };
const rows = (r: Record<string, unknown>[]) => ({ rows: r, rowsAffected: r.length, columns: [] });

function skillRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'sk-1', user_id: 'user-1', slug: 'inbox-triage', name: 'Inbox Triage',
    description: 'Triage the inbox', body: '## Procedure',
    required_services: '["gmail"]', auto_assign: false, enabled: true,
    created_at: 'now', updated_at: 'now', ...over,
  };
}

/**
 * Route the single db mock by inspecting the SQL, so each test only states the
 * rows that matter to it.
 */
function routeDb(handlers: Array<[RegExp, unknown]>) {
  mockExecute.mockImplementation((q: any) => {
    const text: string = typeof q === 'string' ? q : q.sql;
    for (const [pattern, result] of handlers) {
      if (pattern.test(text)) return Promise.resolve(result);
    }
    return Promise.resolve(empty);
  });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  // Stand-in for the real auth plugin's onRequest hook, which is what
  // populates request.session for getUserId().
  app.addHook('onRequest', async (request: any) => {
    request.session = mockGetSession();
  });
  await app.register(apiRoutes);
  await app.ready();
  // validServiceTypes is filled by a floating dynamic import of @reins/servers.
  await new Promise((r) => setTimeout(r, 0));
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  mockGetSession.mockReturnValue({ userId: 'user-1', email: 'me@example.com', role: 'user' });
  mockRequireAdmin.mockReturnValue(true);
  mockResolveAvailability.mockResolvedValue(new Map());
  mockExecute.mockResolvedValue(empty);
  app = await buildApp();
});

describe('POST /api/skills', () => {
  const valid = { name: 'Inbox Triage', description: 'Triage', body: '## Do it' };

  it('rejects a dependency on a service that does not exist', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/skills',
      payload: { ...valid, requiredServices: ['not-a-service'] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('not-a-service');
  });

  it('accepts a dependency on a registered service', async () => {
    routeDb([[/INSERT INTO skills/, empty], [/SELECT \* FROM skills WHERE id/, rows([skillRow()])]]);

    const res = await app.inject({
      method: 'POST', url: '/api/skills',
      payload: { ...valid, requiredServices: ['gmail', 'calendar'] },
    });

    expect(res.statusCode).toBe(201);
  });

  it('rejects a body larger than 64 KB — it is sent to the agent on every read', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/skills',
      payload: { ...valid, body: 'x'.repeat(64 * 1024 + 1) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('exceeds');
  });

  it('requires a name and a body', async () => {
    const noName = await app.inject({ method: 'POST', url: '/api/skills', payload: { ...valid, name: '' } });
    const noBody = await app.inject({ method: 'POST', url: '/api/skills', payload: { ...valid, body: '' } });

    expect(noName.statusCode).toBe(400);
    expect(noBody.statusCode).toBe(400);
  });

  it('refuses to let a non-admin author a system skill', async () => {
    mockRequireAdmin.mockReturnValue(false);

    await app.inject({
      method: 'POST', url: '/api/skills', payload: { ...valid, isSystem: true },
    });

    expect(mockRequireAdmin).toHaveBeenCalled();
    // requireAdmin sends its own 403; the handler must not have inserted.
    const inserted = mockExecute.mock.calls.some((c: any[]) =>
      String(c[0]?.sql ?? c[0]).includes('INSERT INTO skills')
    );
    expect(inserted).toBe(false);
  });
});

describe('PUT/DELETE /api/skills/:id', () => {
  it("returns 404 for another user's skill rather than 403", async () => {
    // The read is scoped by user_id, so a foreign id simply yields no row.
    routeDb([[/SELECT \* FROM skills WHERE id/, empty]]);

    const put = await app.inject({
      method: 'PUT', url: '/api/skills/sk-other',
      payload: { name: 'x', description: 'y', body: 'z' },
    });
    const del = await app.inject({ method: 'DELETE', url: '/api/skills/sk-other' });

    expect(put.statusCode).toBe(404);
    expect(del.statusCode).toBe(404);
  });

  it('blocks a non-admin from editing a system skill they can read', async () => {
    mockRequireAdmin.mockReturnValue(false);
    routeDb([[/SELECT \* FROM skills WHERE id/, rows([skillRow({ user_id: null })])]]);

    await app.inject({
      method: 'PUT', url: '/api/skills/inbox-triage',
      payload: { name: 'Hijacked', description: 'y', body: 'z' },
    });

    expect(mockRequireAdmin).toHaveBeenCalled();
    const updated = mockExecute.mock.calls.some((c: any[]) =>
      String(c[0]?.sql ?? c[0]).includes('UPDATE skills SET')
    );
    expect(updated).toBe(false);
  });
});

describe('PUT /api/agents/:id/skills', () => {
  it('returns 409 naming the missing service when a dependency is unmet', async () => {
    routeDb([
      [/SELECT 1 FROM agents/, rows([{ '?column?': 1 }])],
      [/SELECT \* FROM skills WHERE id/, rows([skillRow()])],
    ]);
    mockResolveAvailability.mockResolvedValue(
      new Map([['sk-1', { available: false, missingServices: ['gmail'] }]])
    );

    const res = await app.inject({
      method: 'PUT', url: '/api/agents/agent-1/skills', payload: { skillIds: ['sk-1'] },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MISSING_SERVICES');
    expect(res.json().error.message).toContain('gmail');
    // Nothing was written.
    const wrote = mockExecute.mock.calls.some((c: any[]) =>
      String(c[0]?.sql ?? c[0]).includes('INSERT INTO agent_skills')
    );
    expect(wrote).toBe(false);
  });

  it('assigns when every dependency is satisfied', async () => {
    routeDb([
      [/SELECT 1 FROM agents/, rows([{ '?column?': 1 }])],
      [/SELECT \* FROM skills WHERE id/, rows([skillRow()])],
    ]);
    mockResolveAvailability.mockResolvedValue(
      new Map([['sk-1', { available: true, missingServices: [] }]])
    );

    const res = await app.inject({
      method: 'PUT', url: '/api/agents/agent-1/skills', payload: { skillIds: ['sk-1'] },
    });

    expect(res.statusCode).toBe(200);
    const wrote = mockExecute.mock.calls.some((c: any[]) =>
      String(c[0]?.sql ?? c[0]).includes('INSERT INTO agent_skills')
    );
    expect(wrote).toBe(true);
  });

  it("refuses to attach a skill the session user cannot read", async () => {
    routeDb([
      [/SELECT 1 FROM agents/, rows([{ '?column?': 1 }])],
      [/SELECT \* FROM skills WHERE id/, empty],
    ]);

    const res = await app.inject({
      method: 'PUT', url: '/api/agents/agent-1/skills', payload: { skillIds: ['sk-someone-else'] },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for an agent the user does not own", async () => {
    routeDb([[/SELECT 1 FROM agents/, empty]]);

    const res = await app.inject({
      method: 'PUT', url: '/api/agents/agent-x/skills', payload: { skillIds: [] },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/agent-skills (agent audience)', () => {
  it('rejects a request with no gateway token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agent-skills' });

    expect(res.statusCode).toBe(401);
  });

  it('returns only this agent\'s skills, without bodies', async () => {
    routeDb([
      [/FROM deployed_agents da/, rows([{ agent_id: 'agent-1', user_id: 'user-1' }])],
      [/JOIN agent_skills ask/, rows([skillRow()])],
    ]);
    mockResolveAvailability.mockResolvedValue(
      new Map([['sk-1', { available: true, missingServices: [] }]])
    );

    const res = await app.inject({
      method: 'GET', url: '/api/agent-skills',
      headers: { 'x-reins-agent-secret': 'tok' },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toHaveLength(1);
    expect(data[0].slug).toBe('inbox-triage');
    // The list stays cheap — bodies come from /:slug.
    expect(data[0].body).toBeUndefined();
  });

  it('still lists a skill whose service was disconnected, flagged unavailable', async () => {
    routeDb([
      [/FROM deployed_agents da/, rows([{ agent_id: 'agent-1', user_id: 'user-1' }])],
      [/JOIN agent_skills ask/, rows([skillRow()])],
    ]);
    mockResolveAvailability.mockResolvedValue(
      new Map([['sk-1', { available: false, missingServices: ['gmail'] }]])
    );

    const res = await app.inject({
      method: 'GET', url: '/api/agent-skills',
      headers: { 'x-reins-agent-secret': 'tok' },
    });

    const data = res.json().data;
    expect(data).toHaveLength(1);
    expect(data[0].available).toBe(false);
    expect(data[0].missingServices).toEqual(['gmail']);
  });
});

describe('GET /api/agent-skills/:slug', () => {
  it('404s for a slug not assigned to this agent', async () => {
    routeDb([
      [/FROM deployed_agents da/, rows([{ agent_id: 'agent-1', user_id: 'user-1' }])],
      [/JOIN agent_skills ask/, rows([skillRow()])],
    ]);
    mockResolveAvailability.mockResolvedValue(
      new Map([['sk-1', { available: true, missingServices: [] }]])
    );

    const res = await app.inject({
      method: 'GET', url: '/api/agent-skills/some-other-slug',
      headers: { 'x-reins-agent-secret': 'tok' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('reaches a skill referenced by an assigned one, and renders the reference', async () => {
    // A reference grants access: deep-research is not assigned, but the
    // assigned skill's body points at it.
    routeDb([
      [/FROM deployed_agents da/, rows([{ agent_id: 'agent-1', user_id: 'user-1' }])],
      [/JOIN agent_skills ask/, rows([skillRow({ body: 'first see {{skill:deep-research}}' })])],
      [/WHERE enabled = true AND \(user_id IS NULL OR user_id = \?\)/, rows([
        skillRow({ body: 'first see {{skill:deep-research}}' }),
        skillRow({ id: 'sk-2', slug: 'deep-research', name: 'Deep Research', body: 'dig deep' }),
      ])],
    ]);
    mockResolveAvailability.mockResolvedValue(
      new Map([['sk-2', { available: true, missingServices: [] }]])
    );

    const res = await app.inject({
      method: 'GET', url: '/api/agent-skills/deep-research',
      headers: { 'x-reins-agent-secret': 'tok' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.slug).toBe('deep-research');
  });

  it('renders {{skill:...}} into an instruction naming the fetch tool', async () => {
    routeDb([
      [/FROM deployed_agents da/, rows([{ agent_id: 'agent-1', user_id: 'user-1', mcp_server_name: 'helm' }])],
      [/JOIN agent_skills ask/, rows([skillRow({ body: 'first see {{skill:deep-research}}' })])],
    ]);
    mockResolveAvailability.mockResolvedValue(
      new Map([['sk-1', { available: true, missingServices: [] }]])
    );

    const res = await app.inject({
      method: 'GET', url: '/api/agent-skills/inbox-triage',
      headers: { 'x-reins-agent-secret': 'tok' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json().data.body;
    expect(body).toContain('`deep-research` skill');
    expect(body).toContain('helm__skills_get');
    expect(body).not.toContain('{{skill:');
  });

  it('distinguishes an existing-but-unreachable skill from a missing one', async () => {
    routeDb([
      [/FROM deployed_agents da/, rows([{ agent_id: 'agent-1', user_id: 'user-1' }])],
      [/JOIN agent_skills ask/, rows([skillRow()])],
      [/WHERE enabled = true AND \(user_id IS NULL OR user_id = \?\)/, rows([
        skillRow(),
        skillRow({ id: 'sk-2', slug: 'unreferenced', body: 'nobody points here' }),
      ])],
    ]);
    mockResolveAvailability.mockResolvedValue(new Map());

    const unreachable = await app.inject({
      method: 'GET', url: '/api/agent-skills/unreferenced',
      headers: { 'x-reins-agent-secret': 'tok' },
    });
    expect(unreachable.statusCode).toBe(404);
    expect(unreachable.json().code).toBe('SKILL_NOT_REACHABLE');

    const missing = await app.inject({
      method: 'GET', url: '/api/agent-skills/no-such-thing',
      headers: { 'x-reins-agent-secret': 'tok' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('SKILL_NOT_FOUND');
  });

  it('returns the body for an assigned slug', async () => {
    routeDb([
      [/FROM deployed_agents da/, rows([{ agent_id: 'agent-1', user_id: 'user-1' }])],
      [/JOIN agent_skills ask/, rows([skillRow()])],
    ]);
    mockResolveAvailability.mockResolvedValue(
      new Map([['sk-1', { available: true, missingServices: [] }]])
    );

    const res = await app.inject({
      method: 'GET', url: '/api/agent-skills/inbox-triage',
      headers: { 'x-reins-agent-secret': 'tok' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.body).toBe('## Procedure');
  });
});

// ============================================================================
// Architect audience — agent-authored skill writes
// ============================================================================

/**
 * These routes authenticate the *agent* and then act as its owner, so the tests
 * that matter are the refusals: another user's skill, a platform skill, and an
 * agent the owner does not own. Plus the one positive guarantee that assignment
 * adds rather than replaces.
 */
describe('agent-authored skill writes', () => {
  const agentAuth = { 'x-reins-agent-secret': 'tok' };
  const deployedRow: [RegExp, unknown] = [
    /FROM deployed_agents da/,
    rows([{ agent_id: 'architect', user_id: 'user-1' }]),
  ];

  it('creates a skill owned by the calling agent\'s owner', async () => {
    routeDb([deployedRow, [/INSERT INTO skills/, rows([])]]);

    const res = await app.inject({
      method: 'POST', url: '/api/agent-skills', headers: agentAuth,
      payload: { name: 'Written By Agent', description: 'When to use.', body: '## Steps' },
    });

    expect(res.statusCode).toBe(201);
    const insert = mockExecute.mock.calls
      .map((c: any) => c[0])
      .find((q: any) => typeof q?.sql === 'string' && q.sql.includes('INSERT INTO skills'));
    // args[1] is user_id — the owner, never the agent id.
    expect(insert.args[1]).toBe('user-1');
  });

  it('refuses to edit a skill the owner does not own', async () => {
    // getWritableSkill matches on user_id, so another user's row simply is not
    // found — the same shape a platform skill takes.
    routeDb([deployedRow, [/SELECT \* FROM skills WHERE id = \? AND user_id = \?/, rows([])]]);

    const res = await app.inject({
      method: 'PUT', url: '/api/agent-skills/id/sk-someone-else', headers: agentAuth,
      payload: { name: 'n', description: 'd', body: 'b' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('refuses to edit a platform skill', async () => {
    // A system skill has user_id IS NULL and can never satisfy `user_id = ?`,
    // so no agent can edit one however it is addressed.
    routeDb([deployedRow, [/SELECT \* FROM skills WHERE id = \? AND user_id = \?/, rows([])]]);

    const res = await app.inject({
      method: 'PUT', url: '/api/agent-skills/id/system-skill', headers: agentAuth,
      payload: { name: 'n', description: 'd', body: 'b' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('adds an assignment without disturbing the agent\'s other skills', async () => {
    routeDb([
      deployedRow,
      [/SELECT 1 FROM agents WHERE id = \? AND user_id = \?/, rows([{ '?column?': 1 }])],
      [/SELECT \* FROM skills WHERE id = \? AND user_id = \?/, rows([skillRow({ required_services: '[]' })])],
      [/INSERT INTO agent_skills/, rows([])],
    ]);
    mockResolveAvailability.mockResolvedValue(
      new Map([['sk-1', { available: true, missingServices: [] }]])
    );

    const res = await app.inject({
      method: 'POST', url: '/api/agent-skills/assign/agent-2', headers: agentAuth,
      payload: { skillId: 'sk-1' },
    });

    expect(res.statusCode).toBe(200);
    // The dashboard route replaces the whole set with a bulk DELETE. This one
    // must not: an architect attaching one skill would otherwise strip every
    // other skill off the target agent.
    const bulkDelete = mockExecute.mock.calls
      .map((c: any) => c[0])
      .find((q: any) =>
        typeof q?.sql === 'string' &&
        q.sql.includes('DELETE FROM agent_skills') &&
        !q.sql.includes('skill_id')
      );
    expect(bulkDelete).toBeUndefined();
  });

  it('refuses to assign to an agent the owner does not own', async () => {
    routeDb([
      deployedRow,
      [/SELECT 1 FROM agents WHERE id = \? AND user_id = \?/, rows([])],
    ]);

    const res = await app.inject({
      method: 'POST', url: '/api/agent-skills/assign/someone-elses-agent', headers: agentAuth,
      payload: { skillId: 'sk-1' },
    });

    expect(res.statusCode).toBe(404);
  });
});
