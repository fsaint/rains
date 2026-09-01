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
  mockIsServiceEnabled,
} = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockGetSession: vi.fn(),
  mockRequireAdmin: vi.fn(),
  mockResolveAvailability: vi.fn(),
  mockIsServiceEnabled: vi.fn(),
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

// Only the enablement check is stubbed — it is the skill-authoring privilege
// boundary, and every other export the route module pulls from here is real.
vi.mock('../services/permissions.js', async () => {
  const actual = await vi.importActual<typeof import('../services/permissions.js')>('../services/permissions.js');
  return { ...actual, isServiceEnabledForAgent: mockIsServiceEnabled };
});

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
    required_services: '["gmail"]', auto_assign: false, enabled: true, source: 'admin',
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
  // Default to an architect; the tests that care flip it off explicitly.
  mockIsServiceEnabled.mockResolvedValue(true);
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

  it('refuses a referenced-but-unassigned skill — a reference is a pointer, not a grant', async () => {
    routeDb([
      [/FROM deployed_agents da/, rows([{ agent_id: 'agent-1', user_id: 'user-1' }])],
      [/JOIN agent_skills ask/, rows([skillRow({ body: 'first see {{skill:deep-research}}' })])],
      [/WHERE enabled = true AND \(user_id IS NULL OR user_id = \?\)/, rows([
        skillRow({ body: 'first see {{skill:deep-research}}' }),
        skillRow({ id: 'sk-2', slug: 'deep-research', name: 'Deep Research', body: 'dig deep' }),
      ])],
    ]);
    mockResolveAvailability.mockResolvedValue(new Map());

    const res = await app.inject({
      method: 'GET', url: '/api/agent-skills/deep-research',
      headers: { 'x-reins-agent-secret': 'tok' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('SKILL_NOT_REACHABLE');
    expect(res.json().error).toContain('not assigned');
  });

  it('renders tokens bare for a manual agent, whose client adds its own prefix', async () => {
    routeDb([
      [/FROM deployed_agents da/, rows([{ agent_id: 'agent-1', user_id: 'user-1', mcp_server_name: 'reins', is_manual: 1 }])],
      [/JOIN agent_skills ask/, rows([skillRow({ body: 'run {{tool:gmail_search}} then see {{skill:deep-research}}' })])],
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
    expect(body).toContain('run gmail_search then');
    expect(body).toContain('open it with skills_get)');
    expect(body).not.toContain('reins__');
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
describe('scoped architect writes — platform skills', () => {
  const agentAuth = { 'x-reins-agent-secret': 'tok' };
  const deployedRow: [RegExp, unknown] = [
    /FROM deployed_agents da/,
    rows([{ agent_id: 'architect', user_id: 'user-1' }]),
  ];
  const adminOwner: [RegExp, unknown] = [
    /SELECT 1 FROM users WHERE id = \? AND role = 'admin'/,
    rows([{ '?column?': 1 }]),
  ];
  const systemRow = (over: Record<string, unknown> = {}) =>
    skillRow({ id: 'stock', slug: 'stock', user_id: null, source: 'template', ...over });

  const insertOf = () =>
    mockExecute.mock.calls
      .map((c: any) => c[0])
      .find((q: any) => typeof q?.sql === 'string' && q.sql.includes('INSERT INTO skills'));

  it('creates a platform skill for an admin owner, keyed by slug and marked admin-authored', async () => {
    routeDb([deployedRow, adminOwner, [/INSERT INTO skills/, rows([])]]);

    const res = await app.inject({
      method: 'POST', url: '/api/agent-skills', headers: agentAuth,
      payload: { name: 'Stock Play', description: 'When to use.', body: '## Steps', slug: 'stock-play', scope: 'system' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.scope).toBe('system');
    const insert = insertOf();
    // A platform skill's id *is* its slug — that is what lets the seeder update
    // in place rather than duplicate.
    expect(insert.args[0]).toBe('stock-play');
    expect(insert.args[1]).toBeNull();
    expect(insert.sql).toContain("'admin'");
  });

  it('refuses a platform write when the owner is not an admin, and writes nothing', async () => {
    routeDb([deployedRow, [/SELECT 1 FROM users WHERE id = \? AND role = 'admin'/, rows([])]]);

    const res = await app.inject({
      method: 'POST', url: '/api/agent-skills', headers: agentAuth,
      payload: { name: 'Stock Play', description: 'When to use.', body: '## Steps', scope: 'system' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ADMIN_REQUIRED');
    expect(insertOf()).toBeUndefined();
  });

  it('refuses a suspended admin — the role check requires an active account', async () => {
    // isAdminUser filters on status = 'active', so a suspended admin's still-live
    // agent token stops being able to write what every account loads.
    routeDb([deployedRow, [/SELECT 1 FROM users WHERE id = \? AND role = 'admin'/, rows([])]]);

    const res = await app.inject({
      method: 'POST', url: '/api/agent-skills', headers: agentAuth,
      payload: { name: 'X', description: 'd', body: 'b', scope: 'system' },
    });

    expect(res.statusCode).toBe(403);
    const roleQuery = mockExecute.mock.calls
      .map((c: any) => c[0])
      .find((q: any) => typeof q?.sql === 'string' && q.sql.includes("role = 'admin'"));
    expect(roleQuery.sql).toContain("status = 'active'");
  });

  it('rejects a scope that is neither value', async () => {
    routeDb([deployedRow]);

    const res = await app.inject({
      method: 'POST', url: '/api/agent-skills', headers: agentAuth,
      payload: { name: 'X', description: 'd', body: 'b', scope: 'platform' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('checks service enablement before the owner role, so a non-architect learns nothing about its owner', async () => {
    mockIsServiceEnabled.mockResolvedValue(false);
    routeDb([deployedRow, adminOwner]);

    const res = await app.inject({
      method: 'POST', url: '/api/agent-skills', headers: agentAuth,
      payload: { name: 'X', description: 'd', body: 'b', scope: 'system' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SERVICE_NOT_ENABLED');
    const roleQuery = mockExecute.mock.calls
      .map((c: any) => c[0])
      .find((q: any) => typeof q?.sql === 'string' && q.sql.includes("role = 'admin'"));
    expect(roleQuery).toBeUndefined();
  });

  it('does not touch a platform row when scope is omitted, even for an admin owner', async () => {
    // The explicit opt-in is the safety property: a mistyped id must not become
    // a platform-wide edit just because the caller happens to be an admin.
    routeDb([
      deployedRow, adminOwner,
      [/SELECT \* FROM skills WHERE id = \? AND user_id = \?/, rows([])],
      [/SELECT \* FROM skills WHERE id = \? AND user_id IS NULL/, rows([systemRow()])],
    ]);

    const res = await app.inject({
      method: 'PUT', url: '/api/agent-skills/id/stock', headers: agentAuth,
      payload: { name: 'n', description: 'd', body: 'b' },
    });

    expect(res.statusCode).toBe(409);
    const update = mockExecute.mock.calls
      .map((c: any) => c[0])
      .find((q: any) => typeof q?.sql === 'string' && q.sql.includes('UPDATE skills SET'));
    expect(update).toBeUndefined();
  });

  it('takes a template-seeded skill out of the seeder\'s hands when its content changes', async () => {
    routeDb([
      deployedRow, adminOwner,
      [/SELECT \* FROM skills WHERE id = \? AND user_id IS NULL/, rows([systemRow()])],
      [/UPDATE skills SET/, rows([])],
    ]);

    const res = await app.inject({
      method: 'PUT', url: '/api/agent-skills/id/stock', headers: agentAuth,
      payload: { name: 'Inbox Triage', description: 'Triage the inbox', body: '## Rewritten', scope: 'system' },
    });

    expect(res.statusCode).toBe(200);
    const update = mockExecute.mock.calls
      .map((c: any) => c[0])
      .find((q: any) => typeof q?.sql === 'string' && q.sql.includes('UPDATE skills SET'));
    // args order: name, description, body, required_services, version, source, id
    expect(update.args[5]).toBe('admin');
  });

  it('leaves source alone when an update changes nothing about the content', async () => {
    // Re-sending the same text (or toggling metadata) must not detach a stock
    // skill from future template fixes.
    routeDb([
      deployedRow, adminOwner,
      [/SELECT \* FROM skills WHERE id = \? AND user_id IS NULL/, rows([systemRow()])],
      [/UPDATE skills SET/, rows([])],
    ]);

    const res = await app.inject({
      method: 'PUT', url: '/api/agent-skills/id/stock', headers: agentAuth,
      payload: {
        name: 'Inbox Triage', description: 'Triage the inbox', body: '## Procedure',
        requiredServices: ['gmail'], scope: 'system',
      },
    });

    expect(res.statusCode).toBe(200);
    const update = mockExecute.mock.calls
      .map((c: any) => c[0])
      .find((q: any) => typeof q?.sql === 'string' && q.sql.includes('UPDATE skills SET'));
    expect(update.args[5]).toBe('template');
  });
});

describe('DELETE /api/agent-skills/id/:id', () => {
  const agentAuth = { 'x-reins-agent-secret': 'tok' };
  const deployedRow: [RegExp, unknown] = [
    /FROM deployed_agents da/,
    rows([{ agent_id: 'architect', user_id: 'user-1' }]),
  ];
  const adminOwner: [RegExp, unknown] = [
    /SELECT 1 FROM users WHERE id = \? AND role = 'admin'/,
    rows([{ '?column?': 1 }]),
  ];

  const deleteOf = () =>
    mockExecute.mock.calls
      .map((c: any) => c[0])
      .find((q: any) => typeof q?.sql === 'string' && q.sql.includes('DELETE FROM skills'));

  it('deletes a skill the owner owns and reports how many agents lose it', async () => {
    routeDb([
      deployedRow,
      [/SELECT \* FROM skills WHERE id = \? AND user_id = \?/, rows([skillRow()])],
      [/count\(\*\) AS n FROM agent_skills/, rows([{ n: 3 }])],
    ]);

    const res = await app.inject({
      method: 'DELETE', url: '/api/agent-skills/id/sk-1', headers: agentAuth,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.deleted).toBe(true);
    expect(res.json().data.detachedFrom).toBe(3);
    // A user skill cannot be resurrected by the seeder, so no warning.
    expect(res.json().data.reseeds).toBeUndefined();
    expect(deleteOf()).toBeDefined();
  });

  it('404s for a skill belonging to someone else, and deletes nothing', async () => {
    routeDb([deployedRow, [/SELECT \* FROM skills WHERE id = \?/, rows([])]]);

    const res = await app.inject({
      method: 'DELETE', url: '/api/agent-skills/id/someone-elses', headers: agentAuth,
    });

    expect(res.statusCode).toBe(404);
    expect(deleteOf()).toBeUndefined();
  });

  it('deletes a platform skill for an admin owner and warns that the template will restore it', async () => {
    routeDb([
      deployedRow, adminOwner,
      [/SELECT \* FROM skills WHERE id = \? AND user_id IS NULL/, rows([skillRow({ id: 'stock', slug: 'stock', user_id: null })])],
      [/count\(\*\) AS n FROM agent_skills/, rows([{ n: 41 }])],
    ]);

    const res = await app.inject({
      method: 'DELETE', url: '/api/agent-skills/id/stock?scope=system', headers: agentAuth,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.detachedFrom).toBe(41);
    expect(res.json().data.reseeds).toBe(true);
  });

  it('refuses a platform delete when the owner is not an admin', async () => {
    routeDb([deployedRow, [/SELECT 1 FROM users WHERE id = \? AND role = 'admin'/, rows([])]]);

    const res = await app.inject({
      method: 'DELETE', url: '/api/agent-skills/id/stock?scope=system', headers: agentAuth,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ADMIN_REQUIRED');
    expect(deleteOf()).toBeUndefined();
  });
});

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

  it('refuses to edit a platform skill without an explicit scope, and says which argument reaches it', async () => {
    // Scope defaults to 'user', whose lookup requires `user_id = ?` and so can
    // never match a system row. The extra system lookup only runs to *explain*
    // the miss — it does not widen what a scopeless call can write.
    routeDb([
      deployedRow,
      [/SELECT \* FROM skills WHERE id = \? AND user_id = \?/, rows([])],
      [/SELECT \* FROM skills WHERE id = \? AND user_id IS NULL/, rows([skillRow({ id: 'system-skill', slug: 'system-skill', user_id: null })])],
    ]);

    const res = await app.inject({
      method: 'PUT', url: '/api/agent-skills/id/system-skill', headers: agentAuth,
      payload: { name: 'n', description: 'd', body: 'b' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SCOPE_REQUIRED');
    expect(res.json().error.message).toContain('scope:"system"');
  });

  it('attaches a platform skill to the owner\'s agent — assignment is not a privileged act', async () => {
    // The regression this covers: assignment used to resolve through the *write*
    // scope, so a platform skill the dashboard could attach was unreachable to
    // the architect that manages the agent — and, because the detach branch sits
    // below the same lookup, undetachable too.
    routeDb([
      deployedRow,
      [/SELECT 1 FROM agents WHERE id = \? AND user_id = \?/, rows([{ '?column?': 1 }])],
      [/SELECT \* FROM skills WHERE id = \? AND \(user_id = \? OR user_id IS NULL\)/,
        rows([skillRow({ id: 'stock', slug: 'stock', user_id: null, required_services: '[]' })])],
      [/INSERT INTO agent_skills/, rows([])],
    ]);
    mockResolveAvailability.mockResolvedValue(
      new Map([['stock', { available: true, missingServices: [] }]])
    );

    const res = await app.inject({
      method: 'POST', url: '/api/agent-skills/assign/agent-2', headers: agentAuth,
      payload: { skillId: 'stock' },
    });

    expect(res.statusCode).toBe(200);
  });

  it('still refuses to assign a skill belonging to another account', async () => {
    // Widening assignment to the readable scope must not become "any skill":
    // getReadableSkill is own-or-system, and a third party's row is neither.
    routeDb([
      deployedRow,
      [/SELECT 1 FROM agents WHERE id = \? AND user_id = \?/, rows([{ '?column?': 1 }])],
      [/SELECT \* FROM skills WHERE id = \? AND \(user_id = \? OR user_id IS NULL\)/, rows([])],
    ]);

    const res = await app.inject({
      method: 'POST', url: '/api/agent-skills/assign/agent-2', headers: agentAuth,
      payload: { skillId: 'someone-elses' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('adds an assignment without disturbing the agent\'s other skills', async () => {
    routeDb([
      deployedRow,
      [/SELECT 1 FROM agents WHERE id = \? AND user_id = \?/, rows([{ '?column?': 1 }])],
      // Assignment resolves through getReadableSkill — own skills *or* platform
      // ones — not the write-scoped lookup the other architect routes use.
      [/SELECT \* FROM skills WHERE id = \? AND \(user_id = \? OR user_id IS NULL\)/, rows([skillRow({ required_services: '[]' })])],
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

/**
 * The skill-authoring boundary, enforced at the HTTP layer.
 *
 * The MCP endpoint already declines to advertise these tools to an agent without
 * the service. That is not sufficient on its own: every deployed agent holds its
 * own gateway token and REINS_API_URL, so it can reach these routes directly. A
 * skill body is an instruction other agents follow, so the boundary has to hold
 * here too.
 */
describe('skill-authoring enablement boundary (HTTP)', () => {
  const agentAuth = { 'x-reins-agent-secret': 'tok' };
  const deployedRow: [RegExp, unknown] = [
    /FROM deployed_agents da/,
    rows([{ agent_id: 'ordinary-agent', user_id: 'user-1' }]),
  ];

  beforeEach(() => {
    mockIsServiceEnabled.mockResolvedValue(false);
    routeDb([deployedRow]);
  });

  it('refuses to create a skill', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/agent-skills', headers: agentAuth,
      payload: { name: 'Sneaky', description: 'd', body: 'b' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SERVICE_NOT_ENABLED');
    const inserted = mockExecute.mock.calls.some((c: any[]) =>
      String(c[0]?.sql ?? c[0]).includes('INSERT INTO skills')
    );
    expect(inserted).toBe(false);
  });

  it('refuses to update a skill', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/agent-skills/id/sk-1', headers: agentAuth,
      payload: { name: 'n', description: 'd', body: 'b' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('refuses to assign a skill', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/agent-skills/assign/agent-2', headers: agentAuth,
      payload: { skillId: 'sk-1' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('still serves the read-only agent routes, which every agent may use', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/agent-skills', headers: agentAuth,
    });

    expect(res.statusCode).toBe(200);
  });
});

/**
 * GET /api/skill-library — what skill_authoring_list reads.
 *
 * Distinct from GET /api/agent-skills: authoring needs the ids of skills that are
 * assigned to no agent at all. It previously pointed at the dashboard's
 * /api/skills, which resolves its caller from a session and so threw a 500 on
 * every call from a gateway token.
 */
describe('GET /api/skill-catalog (any-agent audience)', () => {
  let app: FastifyInstance;
  const agentAuth = { 'x-reins-agent-secret': 'tok' };
  const deployedRow: [RegExp, unknown] = [
    /FROM deployed_agents da/,
    rows([{ agent_id: 'agent-1', user_id: 'user-1', mcp_server_name: 'helm' }]),
  ];

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSession.mockReturnValue(null);
    mockResolveAvailability.mockResolvedValue(new Map());
    app = await buildApp();
  });

  it('rejects a request with no gateway token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/skill-catalog' });
    expect(res.statusCode).toBe(401);
  });

  it('does not require the skill-authoring service', async () => {
    // That gate guards editing; this is browse-only discovery for every agent.
    mockIsServiceEnabled.mockResolvedValue(false);
    routeDb([deployedRow, [/AS assigned_to_me/, rows([])]]);

    const res = await app.inject({ method: 'GET', url: '/api/skill-catalog', headers: agentAuth });

    expect(res.statusCode).toBe(200);
  });

  it('returns owner and platform skills with the assigned flag and never a body', async () => {
    routeDb([
      deployedRow,
      [/AS assigned_to_me/, rows([
        { ...skillRow({ id: 'sk-sys', user_id: null, slug: 'stock', name: 'Stock', body: 'PLATFORM-SECRET' }), assigned_to_me: false },
        { ...skillRow({ id: 'sk-1', body: 'OWNER-SECRET' }), assigned_to_me: true },
      ])],
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/skill-catalog', headers: agentAuth });

    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data[0]).toEqual(expect.objectContaining({ slug: 'stock', scope: 'system', assignedToMe: false }));
    expect(data[1]).toEqual(expect.objectContaining({ id: 'sk-1', scope: 'user', assignedToMe: true }));
    expect(res.payload).not.toContain('SECRET');
    expect(data[0].body).toBeUndefined();
    expect(data[0].readOnly).toBeUndefined();
  });

  it('scopes the query to the calling agent and its owner', async () => {
    routeDb([deployedRow, [/AS assigned_to_me/, rows([])]]);

    await app.inject({ method: 'GET', url: '/api/skill-catalog', headers: agentAuth });

    const call = mockExecute.mock.calls.find(
      ([q]) => typeof q === 'object' && (q as { sql: string }).sql.includes('assigned_to_me')
    );
    expect(call).toBeDefined();
    expect((call![0] as { args: unknown[] }).args).toEqual(['agent-1', 'user-1']);
  });

  it("renders tokens in descriptions for the caller's runtime", async () => {
    routeDb([
      deployedRow,
      [/AS assigned_to_me/, rows([
        { ...skillRow({ description: 'Use {{tool:gmail_search}}' }), assigned_to_me: true },
      ])],
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/skill-catalog', headers: agentAuth });

    expect(res.json().data[0].description).toBe('Use helm__gmail_search');
  });
});

describe('GET /api/skill-library', () => {
  const agentAuth = { 'x-reins-agent-secret': 'tok' };
  const deployedRow: [RegExp, unknown] = [
    /FROM deployed_agents da/,
    rows([{ agent_id: 'architect', user_id: 'user-1' }]),
  ];

  it('rejects a request with no gateway token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/skill-library' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses an agent without the skill-authoring service', async () => {
    mockIsServiceEnabled.mockResolvedValue(false);
    routeDb([deployedRow]);

    const res = await app.inject({ method: 'GET', url: '/api/skill-library', headers: agentAuth });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SERVICE_NOT_ENABLED');
  });

  it("returns the owner's skills and the platform's, flagging the platform ones", async () => {
    routeDb([
      deployedRow,
      [/FROM skills WHERE user_id = \? OR user_id IS NULL/, rows([
        skillRow({ id: 'sk-sys', user_id: null, slug: 'stock', name: 'Stock' }),
        skillRow({ id: 'sk-1' }),
      ])],
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/skill-library', headers: agentAuth });

    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.map((s: any) => s.id)).toEqual(['sk-sys', 'sk-1']);
    expect(data[0].isSystem).toBe(true);
    expect(data[1].isSystem).toBe(false);
  });

  it('scopes the query to the calling agent\'s owner', async () => {
    routeDb([deployedRow, [/FROM skills WHERE user_id = \? OR user_id IS NULL/, rows([])]]);

    await app.inject({ method: 'GET', url: '/api/skill-library', headers: agentAuth });

    const query = mockExecute.mock.calls
      .map((c: any) => c[0])
      .find((q: any) => typeof q?.sql === 'string' && q.sql.includes('OR user_id IS NULL'));
    expect(query.args).toEqual(['user-1']);
  });

  it('omits bodies — the list is for picking an id, not for reading skills', async () => {
    routeDb([
      deployedRow,
      [/FROM skills WHERE user_id = \? OR user_id IS NULL/, rows([skillRow({ body: 'secret procedure' })])],
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/skill-library', headers: agentAuth });

    expect(res.json().data[0]).not.toHaveProperty('body');
    expect(res.payload).not.toContain('secret procedure');
  });
});

/**
 * GET /api/skill-library/:idOrSlug — what skill_authoring_get reads.
 *
 * The two things it must NOT do are what distinguish it from
 * GET /api/agent-skills/:slug: it applies no assignment check, and it does not
 * render {{tool:…}} / {{skill:…}} tokens. The second is the sharp one — an
 * author that read a rendered body and passed it to skill_authoring_update
 * would write one runtime's tool names into the stored skill and break it for
 * the other.
 */
describe('GET /api/skill-library/:idOrSlug', () => {
  const agentAuth = { 'x-reins-agent-secret': 'tok' };
  const deployedRow: [RegExp, unknown] = [
    /FROM deployed_agents da/,
    rows([{ agent_id: 'architect', user_id: 'user-1' }]),
  ];
  const lookup = /FROM skills\s+WHERE \(id = \? OR slug = \?\)/;

  it('rejects a request with no gateway token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/skill-library/sk-1' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses an agent without the skill-authoring service', async () => {
    mockIsServiceEnabled.mockResolvedValue(false);
    routeDb([deployedRow]);

    const res = await app.inject({ method: 'GET', url: '/api/skill-library/sk-1', headers: agentAuth });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SERVICE_NOT_ENABLED');
  });

  it('returns the body, which the list deliberately omits', async () => {
    routeDb([deployedRow, [lookup, rows([skillRow({ body: '## Procedure' })])]]);

    const res = await app.inject({ method: 'GET', url: '/api/skill-library/sk-1', headers: agentAuth });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.body).toBe('## Procedure');
  });

  it('serves a skill assigned to nobody — an author reads what it does not run', async () => {
    // No agent_skills lookup happens at all; that is the whole difference from
    // /api/agent-skills/:slug, which 404s an unassigned skill.
    routeDb([deployedRow, [lookup, rows([skillRow()])]]);

    const res = await app.inject({ method: 'GET', url: '/api/skill-library/sk-1', headers: agentAuth });

    expect(res.statusCode).toBe(200);
    const assignmentQuery = mockExecute.mock.calls
      .map((c: any) => c[0])
      .find((q: any) => typeof q?.sql === 'string' && q.sql.includes('agent_skills'));
    expect(assignmentQuery).toBeUndefined();
  });

  it('leaves tokens unrendered, so an author can write the body back unchanged', async () => {
    routeDb([deployedRow, [lookup, rows([
      skillRow({ body: 'Use {{tool:gmail_search}}, then {{skill:filing}}.' }),
    ])]]);

    const res = await app.inject({ method: 'GET', url: '/api/skill-library/sk-1', headers: agentAuth });

    const body = res.json().data.body;
    expect(body).toContain('{{tool:gmail_search}}');
    expect(body).toContain('{{skill:filing}}');
    expect(body).not.toContain('helm__');
  });

  it('reports no availability, which would be false on every read for an author', async () => {
    // An architect holds none of the services a skill requires, so `available:
    // false` would be noise on every single call rather than information.
    routeDb([deployedRow, [lookup, rows([skillRow({ required_services: '["gmail"]' })])]]);

    const res = await app.inject({ method: 'GET', url: '/api/skill-library/sk-1', headers: agentAuth });

    expect(res.json().data).not.toHaveProperty('available');
    expect(res.json().data).not.toHaveProperty('missingServices');
    // The requirement itself is still reported — an author needs to know it.
    expect(res.json().data.requiredServices).toEqual(['gmail']);
  });

  it('accepts a slug as well as an id, and scopes both to the owner', async () => {
    routeDb([deployedRow, [lookup, rows([skillRow()])]]);

    await app.inject({ method: 'GET', url: '/api/skill-library/inbox-triage', headers: agentAuth });

    const query = mockExecute.mock.calls
      .map((c: any) => c[0])
      .find((q: any) => typeof q?.sql === 'string' && lookup.test(q.sql));
    expect(query.args).toEqual(['inbox-triage', 'inbox-triage', 'user-1']);
  });

  it('flags a platform skill read-only rather than letting the update fail later', async () => {
    routeDb([deployedRow, [lookup, rows([skillRow({ id: 'sk-sys', user_id: null })])]]);

    const res = await app.inject({ method: 'GET', url: '/api/skill-library/sk-sys', headers: agentAuth });

    expect(res.json().data.readOnly).toBe(true);
  });

  it('404s a skill that is not on this account', async () => {
    routeDb([deployedRow, [lookup, rows([])]]);

    const res = await app.inject({ method: 'GET', url: '/api/skill-library/nope', headers: agentAuth });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('SKILL_NOT_FOUND');
  });
});
