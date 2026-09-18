/**
 * Route-level tests for GET /api/permissions/:agentId/drive/folders — the
 * folder browser behind the Drive path-rule picker. Mirrors the Hermeneutix
 * projects route: the agent must be the session user's, the credential must
 * be one of the owner's Google accounts, and the listing is a plain Drive
 * REST call with the account's token.
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
  config: { dashboardUrl: 'http://localhost:5173', publicUrl: 'http://localhost:3000', nodeEnv: 'test', encryptionKey: '0'.repeat(64) },
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

const AGENT = 'agent-1';
const CRED = 'cred-google';

/** Serve the agent, the credential, and the agent's default Drive instance. */
function wireDb(opts: { agentOwner?: string | null; credService?: string; credOwner?: string; instanceCred?: string | null } = {}) {
  const { agentOwner = 'user-1', credService = 'google', credOwner = 'user-1', instanceCred = CRED } = opts;
  mockExecute.mockImplementation(async (q: any) => {
    const sql: string = typeof q === 'string' ? q : q.sql;
    const rows = (r: unknown[]) => ({ rows: r, rowsAffected: r.length, columns: [] });
    if (sql.includes('FROM agents WHERE id = ? AND user_id = ?')) {
      return agentOwner === null ? rows([]) : rows([{ id: AGENT, user_id: agentOwner }]);
    }
    if (sql.includes('FROM agent_service_instances') && sql.includes("service_type = 'drive'")) {
      return instanceCred ? rows([{ credential_id: instanceCred }]) : rows([]);
    }
    if (sql.includes('FROM credentials WHERE id = ?')) {
      return rows([{ id: CRED, service_id: credService, user_id: credOwner }]);
    }
    return rows([]);
  });
}

/** Google's Drive REST API, recording the URLs it was asked for. */
function driveAnswers(handlers: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    calls.push(u);
    for (const [prefix, body] of Object.entries(handlers)) {
      if (u.startsWith(prefix)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }));
  return calls;
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mockGetSession.mockReturnValue({ userId: 'user-1' });
  mockRequireAdmin.mockReturnValue(true);
  mockVault.getValidAccessToken.mockResolvedValue('drive-token');
  wireDb();

  app = Fastify({ logger: false });
  await app.register(cookie);
  app.addHook('onRequest', async (request) => {
    (request as unknown as { session: unknown }).session = { userId: 'user-1' };
  });
  await app.register(apiRoutes);
  await app.ready();
});

const get = (qs = '') => app.inject({ method: 'GET', url: `/api/permissions/${AGENT}/drive/folders${qs}` });

describe('GET /api/permissions/:agentId/drive/folders', () => {
  it('lists My Drive and the shared drives at the top level', async () => {
    const calls = driveAnswers({
      'https://www.googleapis.com/drive/v3/drives': { drives: [{ id: 'sd-1', name: 'Marketing' }] },
    });

    const res = await get();

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      folders: [{ id: 'root', name: 'My Drive' }],
      sharedDrives: [{ id: 'sd-1', name: 'Marketing' }],
    });
    expect(calls).toHaveLength(1);
    const headers = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer drive-token');
  });

  it('lists the subfolders of a parent, folders only, not trashed, by name', async () => {
    const calls = driveAnswers({
      'https://www.googleapis.com/drive/v3/files': { files: [{ id: 'f-acme', name: 'Acme' }, { id: 'f-beta', name: 'Beta' }] },
    });

    const res = await get('?parentId=FOLDER_CLIENTS');

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ folders: [{ id: 'f-acme', name: 'Acme' }, { id: 'f-beta', name: 'Beta' }] });
    const url = new URL(calls[0]);
    expect(url.searchParams.get('q')).toBe(
      "'FOLDER_CLIENTS' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
    );
    expect(url.searchParams.get('orderBy')).toBe('name');
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(url.searchParams.get('includeItemsFromAllDrives')).toBe('true');
  });

  it('rejects a parent id that is not a Drive id, before calling Google', async () => {
    const calls = driveAnswers({});

    const res = await get("?parentId=x'%20or%201=1");

    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('uses the credential named in the query, and refuses one that is not the owner\'s Google account', async () => {
    wireDb({ credOwner: 'user-2' });
    driveAnswers({});

    const res = await get(`?credentialId=${CRED}`);

    expect(res.statusCode).toBe(403);
  });

  it('refuses a credential that is not a Google account', async () => {
    wireDb({ credService: 'microsoft' });
    driveAnswers({});

    const res = await get(`?credentialId=${CRED}`);

    expect(res.statusCode).toBe(403);
  });

  it('404s an agent the session user does not own', async () => {
    wireDb({ agentOwner: null });
    driveAnswers({});

    const res = await get();

    expect(res.statusCode).toBe(404);
  });

  it('400s when the agent has no Drive account and none was named', async () => {
    wireDb({ instanceCred: null });
    driveAnswers({});

    const res = await get();

    expect(res.statusCode).toBe(400);
  });

  it('401s with INVALID_TOKEN when the stored token cannot be refreshed', async () => {
    mockVault.getValidAccessToken.mockResolvedValue(null);
    driveAnswers({});

    const res = await get();

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_TOKEN');
  });

  it('maps a Google 401 to INVALID_TOKEN and any other upstream failure to 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    expect((await get()).statusCode).toBe(401);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    expect((await get()).statusCode).toBe(502);
  });
});
