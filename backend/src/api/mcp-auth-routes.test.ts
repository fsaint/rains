/**
 * Route-level tests for POST/GET/DELETE /mcp/:agentId.
 *
 * These exist because `agent-endpoint.test.ts` calls `handleMCPRequest`
 * directly and never builds a Fastify app — so its ~30 tests would keep passing
 * with the authentication gate completely broken. Nothing else exercises the
 * route, which is where the gate lives.
 *
 * The property under test is the migration promise: an agent that works today
 * keeps working, and only an owner's explicit switch changes that.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

const { mockExecute, mockGetSession, mockRequireAdmin, mockHandleMCP, mockVerifyToken } = vi.hoisted(
  () => ({
    mockExecute: vi.fn(),
    mockGetSession: vi.fn(),
    mockRequireAdmin: vi.fn(),
    mockHandleMCP: vi.fn(),
    mockVerifyToken: vi.fn(),
  })
);

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

vi.mock('../mcp/agent-endpoint.js', () => ({ handleMCPRequest: mockHandleMCP }));

vi.mock('../mcp/oauth/tokens.js', () => ({
  verifyAccessToken: mockVerifyToken,
  listAgentTokens: vi.fn().mockResolvedValue([]),
  revokeAccessToken: vi.fn().mockResolvedValue(true),
}));

vi.mock('@reins/servers', () => ({
  serviceDefinitions: [],
  serviceRegistry: new Map(),
  getServiceTypeFromToolName: () => null,
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
    log: vi.fn().mockResolvedValue(1), logApproval: vi.fn().mockResolvedValue(1),
    logToolCall: vi.fn().mockResolvedValue(1), logAgentEvent: vi.fn().mockResolvedValue(1),
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
  parseWikilinkRefs: vi.fn(), updateLinkIndex: vi.fn(), updateTagIndex: vi.fn(),
  ensureMemoryRoot: vi.fn(), getDreamManifest: vi.fn(), setEntryParent: vi.fn(),
  resolveOrCreate: vi.fn(), parseTransclusions: vi.fn(), lookupEntryByTitleOrAlias: vi.fn(),
}));
vi.mock('../services/memory-scopes.js', () => ({
  resolveMemoryContext: vi.fn(), listUserScopes: vi.fn(), getAgentScopeGrants: vi.fn(),
  setAgentScopeGrants: vi.fn(), pickScope: vi.fn(), isRejection: vi.fn(),
}));
vi.mock('../providers/index.js', () => ({}));
vi.mock('../services/model-router.js', () => ({
  listModelConfigs: vi.fn(), upsertModelConfig: vi.fn(), deleteModelConfig: vi.fn(),
}));

import { apiRoutes } from './routes.js';

const AGENT = 'agent-1';
const OK = { jsonrpc: '2.0', id: 1, result: { tools: [] } };

/** Only the deployment lookup the auth gate makes; everything else is empty. */
function deploymentAllows(allowed: boolean | null) {
  mockExecute.mockImplementation(async (q: any) => {
    const sql: string = typeof q === 'string' ? q : q.sql;
    if (sql.includes('allow_unauthenticated') && sql.includes('FROM deployed_agents')) {
      return allowed === null
        ? { rows: [], rowsAffected: 0, columns: [] }
        : { rows: [{ allow_unauthenticated: allowed }], rowsAffected: 1, columns: [] };
    }
    return { rows: [], rowsAffected: 0, columns: [] };
  });
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  mockGetSession.mockReturnValue(null);
  mockRequireAdmin.mockReturnValue(true);
  mockHandleMCP.mockResolvedValue(OK);
  mockVerifyToken.mockResolvedValue(null);
  deploymentAllows(true);

  app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(apiRoutes);
  await app.ready();
  await new Promise((r) => setTimeout(r, 0));
});

const post = (headers: Record<string, string> = {}, method = 'tools/list') =>
  app.inject({
    method: 'POST',
    url: `/mcp/${AGENT}`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: { jsonrpc: '2.0', id: 1, method },
  });

describe('unauthenticated access while the owner still allows it', () => {
  it('serves a request with no Authorization header, exactly as before', async () => {
    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(mockHandleMCP).toHaveBeenCalledWith(AGENT, expect.objectContaining({ method: 'tools/list' }));
  });

  it('serves tools/call over SSE, unauthenticated', async () => {
    mockHandleMCP.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: { content: [] } });

    const res = await post({}, 'tools/call');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.payload).toContain('event: message');
  });

  it('serves a request when the agent has no deployment row at all', async () => {
    // handleMCPRequest owns the agent-not-found shape; the gate must not
    // pre-empt it with a 401.
    deploymentAllows(null);

    expect((await post()).statusCode).toBe(200);
  });
});

describe('once the owner has closed the unauthenticated endpoint', () => {
  beforeEach(() => deploymentAllows(false));

  it('refuses a request with no token', async () => {
    const res = await post();

    expect(res.statusCode).toBe(401);
    expect(mockHandleMCP).not.toHaveBeenCalled();
  });

  it('points the client at the protected-resource document', async () => {
    const res = await post();

    // Without this a compliant client cannot discover where to authenticate.
    expect(res.headers['www-authenticate']).toContain('Bearer');
    expect(res.headers['www-authenticate']).toContain('resource_metadata=');
    expect(res.headers['www-authenticate']).toContain(`/mcp/${AGENT}`);
  });

  it('serves a request carrying a valid token', async () => {
    mockVerifyToken.mockResolvedValue({
      tokenId: 't1', agentId: AGENT, userId: 'u1', clientId: 'c1', name: 'Claude Code',
    });

    const res = await post({ authorization: 'Bearer mcp_good' });

    expect(res.statusCode).toBe(200);
    expect(mockHandleMCP).toHaveBeenCalled();
  });

  it('rejects tools/call before writing the SSE header', async () => {
    // The route writes a 200 SSE head before invoking the handler, so a
    // rejection decided later would ship as a 200 stream containing an error.
    const res = await post({}, 'tools/call');

    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).not.toContain('text/event-stream');
    expect(res.payload).not.toContain('event: message');
  });
});

describe('an invalid token is always an error', () => {
  it('401s even while unauthenticated access is still allowed', async () => {
    // Falling back to unauthenticated here would hide a misconfigured client
    // from the person who set it up — they would believe they were connected.
    deploymentAllows(true);
    mockVerifyToken.mockResolvedValue(null);

    const res = await post({ authorization: 'Bearer mcp_bad' });

    expect(res.statusCode).toBe(401);
    expect(mockHandleMCP).not.toHaveBeenCalled();
  });

  it('401s when the token belongs to a different agent', async () => {
    deploymentAllows(true);
    mockVerifyToken.mockResolvedValue({
      tokenId: 't1', agentId: 'someone-elses-agent', userId: 'u1', clientId: null, name: 'x',
    });

    const res = await post({ authorization: 'Bearer mcp_other' });

    expect(res.statusCode).toBe(401);
    expect(mockHandleMCP).not.toHaveBeenCalled();
  });
});

describe('the other verbs are gated too', () => {
  it('GET returns its descriptor while unauthenticated is allowed', async () => {
    const res = await app.inject({ method: 'GET', url: `/mcp/${AGENT}` });
    expect(res.statusCode).toBe(200);
  });

  it('GET stops echoing the agent id once the endpoint is closed', async () => {
    deploymentAllows(false);

    const res = await app.inject({ method: 'GET', url: `/mcp/${AGENT}` });

    expect(res.statusCode).toBe(401);
    expect(res.payload).not.toContain(AGENT.slice(0, 5) + '"');
  });

  it('DELETE is gated', async () => {
    deploymentAllows(false);
    expect((await app.inject({ method: 'DELETE', url: `/mcp/${AGENT}` })).statusCode).toBe(401);
  });
});

describe('rate limiting', () => {
  it('eventually 429s a caller hammering the endpoint', async () => {
    // 240/minute keyed on the deployment when unauthenticated.
    let last = 200;
    for (let i = 0; i < 250 && last === 200; i++) {
      last = (await post()).statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('new agents are born closed', () => {
  function insertedDeployment(): { sql: string; args: unknown[] } {
    const call = mockExecute.mock.calls
      .map((c) => c[0])
      .find((q: any) => typeof q !== 'string' && /INSERT INTO deployed_agents/i.test(q.sql));
    expect(call, 'expected a deployed_agents insert').toBeDefined();
    return call as { sql: string; args: unknown[] };
  }

  it('create-manual writes allow_unauthenticated = false explicitly', async () => {
    const authed = Fastify({ logger: false });
    await authed.register(cookie);
    authed.addHook('onRequest', async (req: any) => { req.session = { userId: 'user-1' }; });
    await authed.register(apiRoutes);
    await authed.ready();

    const res = await authed.inject({
      method: 'POST',
      url: '/api/agents/create-manual',
      payload: { name: 'Closed by default' },
    });
    expect(res.statusCode).toBe(201);

    const insert = insertedDeployment();
    // The column must be named and set false in the statement itself — not
    // left to the schema default, which is one ALTER away from flipping.
    expect(insert.sql).toMatch(/allow_unauthenticated/);
    const cols = insert.sql.match(/\(([^)]*)\)\s*VALUES/i)![1].split(',').map((s) => s.trim());
    const vals = insert.sql.match(/VALUES\s*\(([^)]*)\)/i)![1].split(',').map((s) => s.trim());
    const idx = cols.indexOf('allow_unauthenticated');
    expect(idx).toBeGreaterThanOrEqual(0);
    const literal = vals[idx];
    const bound = literal === '?' ? insert.args[vals.slice(0, idx).filter((v) => v === '?').length] : literal;
    expect(String(bound)).toBe('false');
    expect(res.json().data.acceptsUnauthenticatedMcp).toBe(false);
  });
});
