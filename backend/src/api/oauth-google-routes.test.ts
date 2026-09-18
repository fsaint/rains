/**
 * Route-level tests for the Google OAuth reconnect path.
 *
 * A reconnect refreshes the tokens of an existing credential. Google decides
 * which account authorizes from the browser session, not from anything we
 * send, so a reconnect started for a business mailbox while the browser is
 * signed into a personal one would silently store personal tokens under the
 * business label. The callback must refuse that, and the start URL must ask
 * Google for the stored account up front.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

const { mockExecute, mockGetSession, mockRequireAdmin, mockPending, mockVault, mockApprove } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockGetSession: vi.fn(),
  mockRequireAdmin: vi.fn(),
  mockPending: { store: vi.fn(), get: vi.fn(), del: vi.fn() },
  mockVault: {
    retrieve: vi.fn(),
    update: vi.fn(),
    updateGrantedServices: vi.fn(),
    storeOAuth: vi.fn(),
  },
  mockApprove: vi.fn(),
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

const CRED = 'cred-biz';
const STORED = 'ops@acme.com';

/** Google's token exchange, then its userinfo, answering with `email`. */
function googleAnswers(email: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({
        access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer',
      }), { status: 200 });
    }
    if (String(url).includes('/oauth2/v2/userinfo')) {
      return new Response(JSON.stringify({ email, name: 'Someone' }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mockGetSession.mockReturnValue({ userId: 'user-1' });
  mockRequireAdmin.mockReturnValue(true);
  mockExecute.mockResolvedValue({ rows: [], rowsAffected: 0, columns: [] });
  mockPending.get.mockResolvedValue({
    service: 'google', userId: 'user-1', grantedServices: ['gmail'],
    reconnectCredentialId: CRED, reauthApprovalId: 'appr-1',
  });
  mockVault.retrieve.mockResolvedValue({
    serviceId: 'google', type: 'oauth2', accountEmail: STORED,
    data: { accessToken: 'old', refreshToken: 'old-rt' },
  });
  mockVault.update.mockResolvedValue(true);
  mockVault.updateGrantedServices.mockResolvedValue(true);

  app = Fastify({ logger: false });
  await app.register(cookie);
  // The auth guard is not registered here; it is what populates request.session.
  app.addHook('onRequest', async (request) => {
    (request as unknown as { session: unknown }).session = { userId: 'user-1' };
  });
  await app.register(apiRoutes);
  await app.ready();
});

const callback = () => app.inject({ method: 'GET', url: '/api/oauth/google/callback?code=c&state=s' });

describe('GET /api/oauth/google/callback on a reconnect', () => {
  it('refuses when Google authorized a different account than the credential holds', async () => {
    googleAnswers('me@gmail.com');

    const res = await callback();

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.pathname).toBe('/credentials');
    expect(location.searchParams.get('oauth_error')).toBe('account_mismatch');
    expect(location.searchParams.get('expected')).toBe(STORED);
    expect(location.searchParams.get('got')).toBe('me@gmail.com');
    // The business credential keeps its business tokens, and the reauth
    // approval stays open: nothing was re-authenticated.
    expect(mockVault.update).not.toHaveBeenCalled();
    expect(mockVault.updateGrantedServices).not.toHaveBeenCalled();
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockVault.storeOAuth).not.toHaveBeenCalled();
  });

  it('accepts the same account regardless of case and refreshes the tokens', async () => {
    googleAnswers('Ops@Acme.com');

    const res = await callback();

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('oauth_success')).toBe('true');
    expect(location.searchParams.get('reconnected')).toBe('true');
    expect(mockVault.update).toHaveBeenCalledWith(CRED, expect.objectContaining({ accessToken: 'at' }));
    expect(mockApprove).toHaveBeenCalledWith('appr-1', expect.any(String));
  });

  it('refuses when the credential being reconnected no longer exists', async () => {
    googleAnswers(STORED);
    mockVault.retrieve.mockResolvedValue(null);

    const res = await callback();

    const location = new URL(res.headers.location as string);
    expect(location.searchParams.get('oauth_error')).toBe('reconnect_not_found');
    expect(mockVault.update).not.toHaveBeenCalled();
    expect(mockVault.storeOAuth).not.toHaveBeenCalled();
  });
});

describe('GET /api/oauth/google with reconnect', () => {
  it('asks Google for the stored account with login_hint', async () => {
    mockExecute.mockImplementation(async (q: any) => {
      const sql: string = typeof q === 'string' ? q : q.sql;
      if (sql.includes('account_email') && sql.includes('FROM credentials')) {
        return { rows: [{ account_email: STORED, user_id: 'user-1' }], rowsAffected: 1, columns: [] };
      }
      return { rows: [], rowsAffected: 0, columns: [] };
    });

    const res = await app.inject({ method: 'GET', url: `/api/oauth/google?reconnect=${CRED}` });

    expect(res.statusCode).toBe(200);
    const authUrl = new URL(res.json().data.authUrl);
    expect(authUrl.searchParams.get('login_hint')).toBe(STORED);
  });

  it('sends no login_hint for a fresh connection', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/oauth/google' });

    const authUrl = new URL(res.json().data.authUrl);
    expect(authUrl.searchParams.get('login_hint')).toBeNull();
  });

  it('ignores a reconnect id that belongs to another user', async () => {
    mockExecute.mockImplementation(async (q: any) => {
      const sql: string = typeof q === 'string' ? q : q.sql;
      if (sql.includes('account_email') && sql.includes('FROM credentials')) {
        return { rows: [{ account_email: STORED, user_id: 'user-2' }], rowsAffected: 1, columns: [] };
      }
      return { rows: [], rowsAffected: 0, columns: [] };
    });

    const res = await app.inject({ method: 'GET', url: `/api/oauth/google?reconnect=${CRED}` });

    const authUrl = new URL(res.json().data.authUrl);
    expect(authUrl.searchParams.get('login_hint')).toBeNull();
  });
});
