/**
 * The upload link: how an agent holding a file on its own machine gets it
 * into Helm without the bytes crossing the model's context.
 *
 * Two routes meet here. One mints a capability from inside Helm, on the
 * gateway token the agent never sees. The other accepts the bytes from
 * outside, on the capability alone. The second must not accept anything
 * else, because it is reachable without a session.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

const { mockExecute, mockGetSession, mockRequireAdmin, mockVault, mockCreateUpload } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockGetSession: vi.fn(),
  mockRequireAdmin: vi.fn(),
  mockVault: { getValidAccessToken: vi.fn(), retrieve: vi.fn() },
  mockCreateUpload: vi.fn(),
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
// Unlike the other route tests, this one needs the real ceiling and a
// createUpload that answers like the service does — both are what the route
// hands back to the agent.
vi.mock('../services/agent-uploads.js', () => ({
  createUpload: mockCreateUpload,
  getUpload: vi.fn(),
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
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
import { mintUploadToken, UPLOAD_PATH } from '../services/upload-links.js';
import jwt from 'jsonwebtoken';

const SECRET = 'a'.repeat(40);
const AGENT = { id: 'agent-1', user_id: 'user-1' };
const PDF = Buffer.from('%PDF-1.7 pretend bytes');

/** The gateway token the create_upload_link tool authenticates with. */
const GATEWAY = 'gw-secret-token';

const CLAIMS = {
  agentId: AGENT.id,
  userId: AGENT.user_id,
  filename: 'Amanda Bean PsyD ROI - MCDS.pdf',
  mimeType: 'application/pdf',
};

/** The only row these routes read: the agent behind a gateway token. */
function wireDb(opts: { agentRows?: unknown[] } = {}) {
  const { agentRows = [AGENT] } = opts;
  mockExecute.mockImplementation(async (q: any) => {
    const sql: string = typeof q === 'string' ? q : q.sql;
    const rows = (r: unknown[]) => ({ rows: r, rowsAffected: r.length, columns: [] });
    if (sql.includes('FROM agents WHERE gateway_token')) return rows(agentRows);
    return rows([]);
  });
}

/** What the real createUpload returns, echoing the name it was given. */
const uploadRecord = (args: any) => ({
  id: 'upl-1',
  agentId: args.agentId,
  filename: args.filename,
  mimeType: args.mimeType,
  sizeBytes: args.data.length,
  sha256: 'deadbeef',
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
});

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mockGetSession.mockReturnValue(null);
  mockRequireAdmin.mockReturnValue(true);
  mockCreateUpload.mockImplementation(async (args: any) => uploadRecord(args));
  wireDb();

  app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(apiRoutes);
  await app.ready();
});

const mint = (payload: unknown, headers: Record<string, string> = { 'x-reins-agent-secret': GATEWAY }) =>
  app.inject({
    method: 'POST',
    url: '/api/agent-uploads/link',
    headers: { 'content-type': 'application/json', ...headers },
    payload: payload as object,
  });

const upload = (token: string | null, body: Buffer = PDF) =>
  app.inject({
    method: 'POST',
    url: UPLOAD_PATH,
    headers: {
      'content-type': 'application/octet-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: body,
  });

describe('POST /api/agent-uploads/link', () => {
  it('mints a link the agent can run as-is', async () => {
    const res = await mint({ filename: CLAIMS.filename, mimeType: 'application/pdf', localPath: '/Users/f/Desktop/roi.pdf' });

    expect(res.statusCode).toBe(201);
    const link = res.json().data;
    expect(link.url).toBe('https://app.helm.mom/api/agent-uploads');
    expect(link.curl).toContain("--data-binary @'/Users/f/Desktop/roi.pdf'");
    expect(link.maxBytes).toBe(25 * 1024 * 1024);
    expect(new Date(link.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('requires a filename', async () => {
    expect((await mint({})).statusCode).toBe(400);
    expect((await mint({ filename: '   ' })).statusCode).toBe(400);
  });

  it('refuses a caller with no gateway token', async () => {
    const res = await mint({ filename: 'x.pdf' }, {});
    expect([401, 403]).toContain(res.statusCode);
  });

  it('refuses a gateway token that matches no agent', async () => {
    wireDb({ agentRows: [] });
    expect((await mint({ filename: 'x.pdf' })).statusCode).toBe(401);
  });
});

describe('POST /api/agent-uploads with a capability token', () => {
  it('stages the bytes and returns an id to attach', async () => {
    const res = await upload(mintUploadToken(CLAIMS));

    expect(res.statusCode).toBe(201);
    expect(res.json().data.id).toBe('upl-1');
    expect(mockCreateUpload).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: AGENT.id, userId: AGENT.user_id, filename: CLAIMS.filename })
    );
  });

  /**
   * The filename is bound into the token. Letting the query string win would
   * make that binding decorative.
   */
  it('keeps the filename the token was minted for', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${UPLOAD_PATH}?filename=something-else.exe&mimeType=application/x-msdownload`,
      headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${mintUploadToken(CLAIMS)}` },
      payload: PDF,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.filename).toBe(CLAIMS.filename);
    expect(res.json().data.mimeType).toBe('application/pdf');
  });

  it('refuses a request with no credential at all', async () => {
    expect((await upload(null)).statusCode).toBe(401);
  });

  it('refuses an expired token', async () => {
    const expired = jwt.sign({ ...CLAIMS, type: 'agent_upload' }, SECRET, { expiresIn: -60 });
    expect((await upload(expired)).statusCode).toBe(401);
  });

  /** Sessions and download links are signed with the same secret. */
  it('refuses a session token replayed as an upload token', async () => {
    const session = jwt.sign({ userId: 'u1', email: 'a@b.c', role: 'admin' }, SECRET, { expiresIn: '7d' });
    expect((await upload(session)).statusCode).toBe(401);
  });

  it('refuses a download token replayed as an upload token', async () => {
    const download = jwt.sign(
      { agentId: 'agent-1', credentialId: 'c1', messageId: 'm1', attachmentId: 'a1', type: 'gmail_attachment' },
      SECRET,
      { expiresIn: '10m' }
    );
    expect((await upload(download)).statusCode).toBe(401);
  });

  it('refuses an empty body', async () => {
    expect((await upload(mintUploadToken(CLAIMS), Buffer.alloc(0))).statusCode).toBe(400);
  });

  /** The gateway token still works; the capability is an addition, not a swap. */
  it('still accepts the gateway token it always did', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${UPLOAD_PATH}?filename=generated.csv&mimeType=text/csv`,
      headers: { 'content-type': 'application/octet-stream', 'x-reins-agent-secret': GATEWAY },
      payload: Buffer.from('a,b\n1,2\n'),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.filename).toBe('generated.csv');
    expect(mockCreateUpload).toHaveBeenCalledTimes(1);
  });
});
