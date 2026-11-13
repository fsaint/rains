/**
 * Route-level tests for GET /api/outlook/attachments/download.
 *
 * The link outlook_mail_get_attachment hands back. Same capability model as
 * the Gmail route: one attachment on one credential, re-authorized against
 * the agent's live Outlook access before streaming.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import jwt from 'jsonwebtoken';

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

import {
  OUTLOOK_ATTACHMENT_DOWNLOAD_PATH,
  mintAttachmentToken,
  type AttachmentTokenClaims,
} from '../services/attachment-links.js';

const CLAIMS: AttachmentTokenClaims = {
  agentId: 'agent-1',
  credentialId: 'cred-ms',
  messageId: 'AAMk=/msg',
  attachmentId: 'AAMk=/att',
  filename: 'contract.pdf',
  mimeType: 'application/pdf',
  size: 11,
};

const BYTES = Buffer.from('hello world');
const outlookToken = (claims: AttachmentTokenClaims = CLAIMS) => mintAttachmentToken(claims, 'outlook');

const sqlSeen: Array<{ sql: string; args: unknown[] }> = [];

function wireDb(opts: { instanceRows?: unknown[] } = {}) {
  const { instanceRows = [{ id: 'inst-1' }] } = opts;
  mockExecute.mockImplementation(async (q: any) => {
    const sql: string = typeof q === 'string' ? q : q.sql;
    sqlSeen.push({ sql, args: q.args ?? [] });
    const rows = (r: unknown[]) => ({ rows: r, rowsAffected: r.length, columns: [] });
    if (sql.includes('agent_service_instances')) return rows(instanceRows);
    return rows([]);
  });
}

function graphAnswers(status = 200, body: Buffer = BYTES) {
  const calls: Array<{ url: string; auth?: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), auth: (init.headers as Record<string, string>)?.Authorization });
    return new Response(status === 200 ? body : '{}', { status });
  }));
  return calls;
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  sqlSeen.length = 0;
  mockGetSession.mockReturnValue(null);
  mockRequireAdmin.mockReturnValue(true);
  mockVault.getValidAccessToken.mockResolvedValue('ms-token');
  wireDb();

  app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(apiRoutes);
  await app.ready();
});

const download = (token?: string) =>
  app.inject({
    method: 'GET',
    url: OUTLOOK_ATTACHMENT_DOWNLOAD_PATH,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe('GET /api/outlook/attachments/download', () => {
  it('streams the raw bytes from Graph with a download disposition and no sniffing', async () => {
    const calls = graphAnswers();

    const res = await download(outlookToken());

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(BYTES)).toBe(true);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-length']).toBe(String(BYTES.length));
    expect(res.headers['content-disposition']).toBe('attachment; filename="contract.pdf"');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // Ids are path-encoded; Graph ids routinely contain "/" and "=".
    expect(calls[0].url).toBe(
      'https://graph.microsoft.com/v1.0/me/messages/AAMk%3D%2Fmsg/attachments/AAMk%3D%2Fatt/$value'
    );
    expect(calls[0].auth).toBe('Bearer ms-token');
    expect(mockVault.getValidAccessToken).toHaveBeenCalledWith('cred-ms');
  });

  it('checks the agent still has that Outlook account, not a Gmail one', async () => {
    graphAnswers();

    await download(outlookToken());

    const check = sqlSeen.find((q) => q.sql.includes('agent_service_instances'))!;
    expect(check.sql).toContain("service_type = 'outlook_mail'");
    expect(check.args).toEqual(['agent-1', 'cred-ms']);
  });

  it('refuses a request with no token', async () => {
    graphAnswers();
    expect((await download()).statusCode).toBe(401);
  });

  /** Gmail and Outlook links share a secret; the type claim keeps them apart. */
  it('refuses a Gmail download token', async () => {
    graphAnswers();

    const res = await download(mintAttachmentToken(CLAIMS));

    expect(res.statusCode).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses a session token replayed as a download token', async () => {
    graphAnswers();
    const session = jwt.sign({ userId: 'u1', email: 'a@b.c', role: 'admin' }, 'a'.repeat(40), { expiresIn: '7d' });

    expect((await download(session)).statusCode).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses once the agent no longer has that account enabled', async () => {
    wireDb({ instanceRows: [] });
    graphAnswers();

    const res = await download(outlookToken());

    expect(res.statusCode).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses when the stored credential can no longer produce a token', async () => {
    mockVault.getValidAccessToken.mockResolvedValue(null);
    graphAnswers();

    expect((await download(outlookToken())).statusCode).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('maps Graph rejections to 401, a missing attachment to 404, and other failures to 502', async () => {
    graphAnswers(401);
    expect((await download(outlookToken())).statusCode).toBe(401);

    graphAnswers(404);
    expect((await download(outlookToken())).statusCode).toBe(404);

    graphAnswers(500);
    expect((await download(outlookToken())).statusCode).toBe(502);
  });

  it('serves a file whose name has an accent', async () => {
    graphAnswers();
    const filename = 'término.xlsx'.normalize('NFD');

    const res = await download(outlookToken({ ...CLAIMS, filename }));

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('filename="termino.xlsx"');
  });

  it('falls back to a generic type when the declared one is not a MIME type', async () => {
    graphAnswers();

    const res = await download(outlookToken({ ...CLAIMS, mimeType: 'text/html; x=<script>' }));

    expect(res.headers['content-type']).toBe('application/octet-stream');
  });
});
