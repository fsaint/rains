/**
 * The root MCP endpoint at /mcp — one URL for every user.
 *
 * The whole point of this file is the authentication boundary. A root token
 * names no agent; an agent token names one. Each must be refused where the
 * other belongs, because accepting an agent token here would let a client
 * trusted with one agent enumerate its siblings, and sibling ids are live
 * credentials for any agent its owner has opened.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

const { mockExecute, mockGetSession, mockRequireAdmin, mockVault } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockGetSession: vi.fn(),
  mockRequireAdmin: vi.fn(),
  mockVault: { getValidAccessToken: vi.fn(), retrieve: vi.fn() },
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
vi.mock('../oauth/pending-flows.js', () => ({
  storePendingOAuthFlow: vi.fn(), getPendingOAuthFlow: vi.fn(), deletePendingOAuthFlow: vi.fn(),
}));
vi.mock('../credentials/vault.js', () => ({ credentialVault: mockVault }));
vi.mock('../mcp/agent-endpoint.js', () => ({ handleMCPRequest: vi.fn() }));
vi.mock('../mcp/oauth/tokens.js', () => ({
  verifyAccessToken: vi.fn(),
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
    publicUrl: 'https://app.helm.mom',
    nodeEnv: 'test',
    encryptionKey: '0'.repeat(64),
    sessionSecret: 'a'.repeat(40),
  },
}));
vi.mock('../policy/engine.js', () => ({ policyEngine: {} }));
vi.mock('../mcp/proxy.js', () => ({ mcpProxy: {} }));
vi.mock('../mcp/server-manager.js', () => ({ serverManager: {} }));
vi.mock('../notifications/apns.js', () => ({ apnsService: {} }));
vi.mock('../notifications/telegram.js', () => ({ telegramNotifier: {} }));
vi.mock('../analytics/posthog.js', () => ({ getPostHog: () => null }));
vi.mock('../services/email.js', () => ({ sendReauthEmail: vi.fn() }));
vi.mock('../services/agent-uploads.js', () => ({ createUpload: vi.fn(), getUpload: vi.fn(), MAX_UPLOAD_BYTES: 1024 }));
vi.mock('../services/memory.js', () => ({
  parseWikilinkRefs: vi.fn(), updateLinkIndex: vi.fn(), updateTagIndex: vi.fn(),
  ensureMemoryRoot: vi.fn(), getDreamManifest: vi.fn(), setEntryParent: vi.fn(),
  resolveOrCreate: vi.fn(), parseTransclusions: vi.fn(), lookupEntryByTitleOrAlias: vi.fn(),
}));
vi.mock('../services/memory-scopes.js', () => ({
  resolveMemoryContext: vi.fn(), listUserScopes: vi.fn(), getAgentScopeGrants: vi.fn(),
  setAgentScopeGrants: vi.fn(), pickScope: vi.fn(), isRejection: vi.fn(),
}));


import { apiRoutes } from './routes.js';
import { LIST_AGENTS_TOOL } from '../mcp/root-endpoint.js';

const { mockVerify } = vi.hoisted(() => ({ mockVerify: vi.fn() }));
vi.mock('../mcp/oauth/tokens.js', () => ({
  verifyAccessToken: mockVerify,
  listAgentTokens: vi.fn().mockResolvedValue([]),
  revokeAccessToken: vi.fn().mockResolvedValue(true),
}));

const AGENTS = [
  { id: 'agent-work', name: 'Work', description: 'Email', allow_unauthenticated: false },
];
const SERVICES = [{ agent_id: 'agent-work', service_type: 'gmail' }];

const rootPrincipal = { tokenId: 'tok-root', agentId: null, userId: 'user-1', clientId: 'c1', name: 'Claude' };
const agentPrincipal = { tokenId: 'tok-a', agentId: 'agent-work', userId: 'user-1', clientId: 'c1', name: 'Claude' };

function wireDb() {
  mockExecute.mockImplementation(async (q: any) => {
    const sql: string = typeof q === 'string' ? q : q.sql;
    const rows = (r: unknown[]) => ({ rows: r, rowsAffected: r.length, columns: [] });
    if (/agent_service_instances/i.test(sql)) return rows(SERVICES);
    if (/FROM agents/i.test(sql)) return rows(AGENTS);
    return rows([]);
  });
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mockGetSession.mockReturnValue(null);
  mockRequireAdmin.mockReturnValue(true);
  mockVerify.mockResolvedValue(null);
  wireDb();

  app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(apiRoutes);
  await app.ready();
});

const rpc = (method: string, token?: string, params?: unknown) =>
  app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
  });

describe('POST /mcp — authentication', () => {
  it('serves a root token', async () => {
    mockVerify.mockResolvedValue(rootPrincipal);

    const res = await rpc('tools/list', 'mcp_root');

    expect(res.statusCode).toBe(200);
    expect(res.json().result.tools[0].name).toBe(LIST_AGENTS_TOOL);
  });

  /**
   * The widening this endpoint must not allow: a token for one agent being
   * accepted as its owner, and so revealing every sibling id.
   */
  it('refuses a token scoped to an agent', async () => {
    mockVerify.mockResolvedValue(agentPrincipal);

    const res = await rpc('tools/list', 'mcp_agent');

    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/one agent cannot be used here/i);
  });

  /** Unlike an agent, there is no "open" root endpoint to fall back to. */
  it('refuses a request with no token at all', async () => {
    const res = await rpc('tools/list');

    expect(res.statusCode).toBe(401);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('refuses a token that does not verify', async () => {
    mockVerify.mockResolvedValue(null);

    expect((await rpc('tools/list', 'mcp_bogus')).statusCode).toBe(401);
  });

  /** RFC 9728: the client is told where to authenticate, at the root resource. */
  it('points a rejected client at the root resource document', async () => {
    const res = await rpc('tools/list');

    expect(res.headers['www-authenticate']).toContain(
      'resource_metadata="https://app.helm.mom/.well-known/oauth-protected-resource/mcp"'
    );
  });

  it('refuses a body that is not JSON-RPC before authenticating', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: '"not an object"',
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('POST /mcp — listing', () => {
  beforeEach(() => mockVerify.mockResolvedValue(rootPrincipal));

  it('returns the agents of the token\'s user', async () => {
    const res = await rpc('tools/call', 'mcp_root', { name: LIST_AGENTS_TOOL, arguments: {} });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.json().result.content[0].text);
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].mcp_url).toBe('https://app.helm.mom/mcp/agent-work');
  });

  it('answers initialize as the root server', async () => {
    const res = await rpc('initialize', 'mcp_root');

    expect(res.json().result.serverInfo.name).toBe('helm-root');
  });

  /** Plain JSON, not the SSE the agent endpoint uses for approvals. */
  it('answers a tool call as JSON rather than an event stream', async () => {
    const res = await rpc('tools/call', 'mcp_root', { name: LIST_AGENTS_TOOL, arguments: {} });

    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

describe('GET and DELETE /mcp', () => {
  it('tells a browser to use POST, once authenticated', async () => {
    mockVerify.mockResolvedValue(rootPrincipal);

    const res = await app.inject({ method: 'GET', url: '/mcp', headers: { authorization: 'Bearer mcp_root' } });

    expect(res.statusCode).toBe(405);
  });

  it('refuses GET without a token rather than explaining itself', async () => {
    expect((await app.inject({ method: 'GET', url: '/mcp' })).statusCode).toBe(401);
  });

  it('accepts DELETE as a no-op for an authenticated client', async () => {
    mockVerify.mockResolvedValue(rootPrincipal);

    const res = await app.inject({ method: 'DELETE', url: '/mcp', headers: { authorization: 'Bearer mcp_root' } });

    expect(res.statusCode).toBe(204);
  });

  it('refuses DELETE with an agent token', async () => {
    mockVerify.mockResolvedValue(agentPrincipal);

    const res = await app.inject({ method: 'DELETE', url: '/mcp', headers: { authorization: 'Bearer mcp_a' } });

    expect(res.statusCode).toBe(401);
  });
});
