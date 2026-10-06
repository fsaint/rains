/**
 * GET /api/config/public tells the login page whether a stranger can sign up,
 * and for how many trial days (reins spec 2026-09-16 §2.2).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

const { mockExecute, mockGetSession, mockRequireAdmin, mockPending, mockVault, mockApprove, mockEnrollment } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockGetSession: vi.fn(),
  mockRequireAdmin: vi.fn(),
  mockPending: { store: vi.fn(), get: vi.fn(), del: vi.fn() },
  mockVault: { retrieve: vi.fn(), update: vi.fn(), updateGrantedServices: vi.fn(), storeOAuth: vi.fn() },
  mockApprove: vi.fn(),
  mockEnrollment: { selfEnroll: true, selfTrialDays: 15 },
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
  storePendingOAuthFlow: mockPending.store,
  getPendingOAuthFlow: mockPending.get,
  deletePendingOAuthFlow: mockPending.del,
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
    requestChanges: vi.fn(), approve: mockApprove, reject: vi.fn(), get: vi.fn(),
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
    googleClientId: 'client-id',
    googleClientSecret: 'client-secret',
    googleRedirectUri: 'http://localhost:5001/api/oauth/google/callback',
    enrollment: mockEnrollment,
  },
}));
vi.mock('../policy/engine.js', () => ({ policyEngine: {} }));
vi.mock('../mcp/proxy.js', () => ({ mcpProxy: {} }));
vi.mock('../mcp/server-manager.js', () => ({ serverManager: {} }));
vi.mock('../notifications/apns.js', () => ({ apnsService: {} }));
vi.mock('../notifications/telegram.js', () => ({ telegramNotifier: {} }));
vi.mock('../analytics/posthog.js', () => ({ getPostHog: () => null }));
vi.mock('../services/email.js', () => ({ sendReauthEmail: vi.fn() }));
vi.mock('../services/agent-uploads.js', () => ({
  createUpload: vi.fn(), getUpload: vi.fn(), MAX_UPLOAD_BYTES: 1024,
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

import { apiRoutes } from './routes.js';

let app: FastifyInstance;

beforeEach(async () => {
  app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(apiRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('GET /api/config/public', () => {
  it('reports self-enrollment and the trial length', async () => {
    mockEnrollment.selfEnroll = true;
    mockEnrollment.selfTrialDays = 15;

    const res = await app.inject({ method: 'GET', url: '/api/config/public' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      selfEnroll: true,
      selfTrialDays: 15,
      rootMcpUrl: 'http://localhost:3000/mcp',
    });
  });

  it('reports self-enrollment off', async () => {
    mockEnrollment.selfEnroll = false;

    const res = await app.inject({ method: 'GET', url: '/api/config/public' });

    expect(res.json().selfEnroll).toBe(false);
  });
});

/**
 * The dashboard shows the discovery endpoint, and in development the SPA and
 * the API sit on different origins — so the URL has to come from the server
 * rather than from window.location.
 */
describe('GET /api/config/public — the discovery endpoint', () => {
  it('publishes the root MCP URL', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config/public' });

    expect(res.json().rootMcpUrl).toBe('http://localhost:3000/mcp');
  });
});
