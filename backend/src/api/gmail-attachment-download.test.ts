/**
 * Route-level tests for GET /api/gmail/attachments/download.
 *
 * The link a Gmail attachment tool call hands back. The token is a
 * capability: it names one attachment on one credential, and the route
 * re-authorizes it against the agent's live access before streaming, so a
 * detached account kills outstanding links.
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

import {
  ATTACHMENT_DOWNLOAD_PATH,
  mintAttachmentToken,
  type AttachmentTokenClaims,
} from '../services/attachment-links.js';
import jwt from 'jsonwebtoken';

const CLAIMS: AttachmentTokenClaims = {
  agentId: 'agent-1',
  credentialId: 'cred-1',
  messageId: 'msg-1',
  attachmentId: 'att-1',
  filename: 'report.pdf',
  mimeType: 'application/pdf',
  size: 11,
};

const BYTES = Buffer.from('hello world');

/** The agent still has an enabled Gmail instance on the token's credential. */
function wireDb(opts: { instanceRows?: unknown[] } = {}) {
  const { instanceRows = [{ id: 'inst-1' }] } = opts;
  mockExecute.mockImplementation(async (q: any) => {
    const sql: string = typeof q === 'string' ? q : q.sql;
    const rows = (r: unknown[]) => ({ rows: r, rowsAffected: r.length, columns: [] });
    if (sql.includes('agent_service_instances')) return rows(instanceRows);
    return rows([]);
  });
}

function gmailAnswers(status = 200, body: unknown = { size: BYTES.length, data: BYTES.toString('base64url') }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), { status });
  }));
  return calls;
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mockGetSession.mockReturnValue(null);
  mockRequireAdmin.mockReturnValue(true);
  mockVault.getValidAccessToken.mockResolvedValue('gmail-token');
  wireDb();

  app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(apiRoutes);
  await app.ready();
});

const download = (token?: string) =>
  app.inject({
    method: 'GET',
    url: ATTACHMENT_DOWNLOAD_PATH,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe('GET /api/gmail/attachments/download', () => {
  it('streams the decoded bytes with a download disposition and no sniffing', async () => {
    const calls = gmailAnswers();

    const res = await download(mintAttachmentToken(CLAIMS));

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(BYTES)).toBe(true);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-length']).toBe(String(BYTES.length));
    expect(res.headers['content-disposition']).toBe('attachment; filename="report.pdf"');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // Read from Gmail with the token's own account, not a default one.
    expect(calls[0]).toContain('/messages/msg-1/attachments/att-1');
    expect(mockVault.getValidAccessToken).toHaveBeenCalledWith('cred-1');
  });

  it('refuses a request with no token', async () => {
    gmailAnswers();
    expect((await download()).statusCode).toBe(401);
  });

  it('refuses a session token replayed as a download token', async () => {
    gmailAnswers();
    const session = jwt.sign({ userId: 'u1', email: 'a@b.c', role: 'admin' }, 'a'.repeat(40), { expiresIn: '7d' });

    const res = await download(session);

    expect(res.statusCode).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  /** The owner detached the account, or the instance was disabled. */
  it('refuses once the agent no longer has that account enabled', async () => {
    wireDb({ instanceRows: [] });
    gmailAnswers();

    const res = await download(mintAttachmentToken(CLAIMS));

    expect(res.statusCode).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses when the stored credential can no longer produce a token', async () => {
    mockVault.getValidAccessToken.mockResolvedValue(null);
    gmailAnswers();

    const res = await download(mintAttachmentToken(CLAIMS));

    expect(res.statusCode).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('maps a Gmail rejection to 401 and any other upstream failure to 502', async () => {
    gmailAnswers(401);
    expect((await download(mintAttachmentToken(CLAIMS))).statusCode).toBe(401);

    gmailAnswers(500);
    expect((await download(mintAttachmentToken(CLAIMS))).statusCode).toBe(502);
  });

  it('falls back to a generic type and name when the token carries none', async () => {
    gmailAnswers();

    const res = await download(mintAttachmentToken({ ...CLAIMS, filename: undefined, mimeType: undefined }));

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe('attachment; filename="attachment.bin"');
  });

  /**
   * Gmail rotates attachment ids between reads. If the id in the token has
   * stopped working, the filename still identifies the file.
   */
  it('recovers from a rotated id by re-reading the message and retrying once', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/attachments/att-1')) return new Response('{}', { status: 404 });
      if (u.includes('?format=full')) {
        return new Response(
          JSON.stringify({ payload: { parts: [{ filename: 'report.pdf', body: { attachmentId: 'att-fresh' } }] } }),
          { status: 200 }
        );
      }
      if (u.includes('/attachments/att-fresh')) {
        return new Response(JSON.stringify({ size: BYTES.length, data: BYTES.toString('base64url') }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }));

    const res = await download(mintAttachmentToken(CLAIMS));

    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(BYTES)).toBe(true);
    expect(calls.some((u) => u.includes('?format=full'))).toBe(true);
    expect(calls.some((u) => u.includes('/attachments/att-fresh'))).toBe(true);
  });

  it('reports a 404 the filename cannot rescue', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).includes('?format=full')
        ? new Response(JSON.stringify({ payload: { parts: [] } }), { status: 200 })
        : new Response('{}', { status: 404 })
    ));

    expect((await download(mintAttachmentToken(CLAIMS))).statusCode).toBe(502);
  });

  /** A sender-chosen name must not be able to inject a header line. */
  it('neutralises a filename carrying a quote or newline', async () => {
    gmailAnswers();

    const res = await download(mintAttachmentToken({ ...CLAIMS, filename: 'evil"\r\nX-Injected: 1.pdf' }));

    expect(res.headers['content-disposition']).toBe('attachment; filename="evilX-Injected: 1.pdf"');
    expect(res.headers['x-injected']).toBeUndefined();
  });
});
