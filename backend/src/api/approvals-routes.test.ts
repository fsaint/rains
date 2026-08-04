/**
 * Tests for the approval decision endpoints.
 *
 * These exercise the real `apiRoutes` plugin through `app.inject` rather than a
 * stand-in, because the properties under test are exactly the ones a
 * reimplementation would get wrong: the ownership guard (approvals are
 * addressed by an unguessable id, which is not an authorization boundary) and
 * the mapping from a requestChanges outcome to an HTTP status.
 *
 * Every collaborator routes.ts imports is stubbed; only the db client, the
 * approval queue, and the session are given behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

// vi.mock factories are hoisted above these declarations, so the spies must be
// created inside vi.hoisted() to exist by the time the factories run.
const {
  mockExecute,
  mockRequestChanges,
  mockApprove,
  mockReject,
  mockGet,
  mockGetSession,
} = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockRequestChanges: vi.fn(),
  mockApprove: vi.fn(),
  mockReject: vi.fn(),
  mockGet: vi.fn(),
  mockGetSession: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  client: { execute: mockExecute },
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

vi.mock('../approvals/queue.js', () => ({
  MAX_REVISIONS: 3,
  approvalQueue: {
    requestChanges: mockRequestChanges,
    approve: mockApprove,
    reject: mockReject,
    get: mockGet,
    submit: vi.fn(),
    listPending: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../auth/index.js', () => ({
  getSession: mockGetSession,
  requireAdmin: vi.fn(async () => true),
  createMagicLinkToken: vi.fn(),
  verifyMagicLinkToken: vi.fn(),
}));

vi.mock('../audit/logger.js', () => ({
  auditLogger: {
    logApproval: vi.fn().mockResolvedValue(1),
    logToolCall: vi.fn().mockResolvedValue(1),
    query: vi.fn().mockResolvedValue([]),
  },
}));

// Remaining collaborators only need to exist at import time.
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

const APPROVAL_ID = 'ap-1';

/** The ownership join returns a row only when the session user owns the agent. */
function ownsIt(owned: boolean) {
  mockExecute.mockResolvedValue({
    rows: owned ? [{ '?column?': 1 }] : [],
    rowsAffected: 0,
    columns: [],
  });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(apiRoutes);
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  mockGetSession.mockReturnValue({ userId: 'user-1', email: 'me@example.com' });
  mockGet.mockResolvedValue({ id: APPROVAL_ID, agentId: 'agent-1', tool: 'gmail_send_message' });
  app = await buildApp();
});

const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, payload: payload as object });

describe('POST /api/approvals/:id/request-changes', () => {
  it('sends the feedback to the queue and returns the updated approval', async () => {
    ownsIt(true);
    mockRequestChanges.mockResolvedValue('ok');

    const response = await post(`/api/approvals/${APPROVAL_ID}/request-changes`, {
      feedback: 'drop Bob, make it shorter',
    });

    expect(response.statusCode).toBe(200);
    expect(mockRequestChanges).toHaveBeenCalledWith(
      APPROVAL_ID,
      'me@example.com',
      'drop Bob, make it shorter'
    );
  });

  it('rejects empty feedback — sending back nothing tells the agent nothing', async () => {
    ownsIt(true);

    const response = await post(`/api/approvals/${APPROVAL_ID}/request-changes`, { feedback: '   ' });

    expect(response.statusCode).toBe(400);
    expect(mockRequestChanges).not.toHaveBeenCalled();
  });

  it('rejects missing feedback', async () => {
    ownsIt(true);

    const response = await post(`/api/approvals/${APPROVAL_ID}/request-changes`, {});

    expect(response.statusCode).toBe(400);
    expect(mockRequestChanges).not.toHaveBeenCalled();
  });

  it('returns 409 at the revision cap so the UI can explain why', async () => {
    ownsIt(true);
    mockRequestChanges.mockResolvedValue('cap_reached');

    const response = await post(`/api/approvals/${APPROVAL_ID}/request-changes`, { feedback: 'again' });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('REVISION_LIMIT_REACHED');
  });

  it('returns 404 when it was already approved or denied elsewhere', async () => {
    ownsIt(true);
    mockRequestChanges.mockResolvedValue('not_pending');

    const response = await post(`/api/approvals/${APPROVAL_ID}/request-changes`, { feedback: 'x' });

    expect(response.statusCode).toBe(404);
  });

  it('refuses to steer another user\'s agent', async () => {
    ownsIt(false);
    mockRequestChanges.mockResolvedValue('ok');

    const response = await post(`/api/approvals/${APPROVAL_ID}/request-changes`, { feedback: 'x' });

    // 404 rather than 403 — do not confirm the approval exists.
    expect(response.statusCode).toBe(404);
    expect(mockRequestChanges).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller', async () => {
    mockGetSession.mockReturnValue(null);
    ownsIt(false);

    const response = await post(`/api/approvals/${APPROVAL_ID}/request-changes`, { feedback: 'x' });

    expect(response.statusCode).toBe(404);
    expect(mockRequestChanges).not.toHaveBeenCalled();
  });
});

// The guard was previously absent on these: any authenticated user could read
// or decide any approval by id.
describe('approval ownership guard', () => {
  it('does not let a non-owner approve', async () => {
    ownsIt(false);
    mockApprove.mockResolvedValue(true);

    const response = await post(`/api/approvals/${APPROVAL_ID}/approve`, {});

    expect(response.statusCode).toBe(404);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('does not let a non-owner reject', async () => {
    ownsIt(false);
    mockReject.mockResolvedValue(true);

    const response = await post(`/api/approvals/${APPROVAL_ID}/reject`, { reason: 'no' });

    expect(response.statusCode).toBe(404);
    expect(mockReject).not.toHaveBeenCalled();
  });

  it('does not let a non-owner read the arguments', async () => {
    ownsIt(false);

    const response = await app.inject({ method: 'GET', url: `/api/approvals/${APPROVAL_ID}` });

    expect(response.statusCode).toBe(404);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('still lets the owner approve', async () => {
    ownsIt(true);
    mockApprove.mockResolvedValue(true);

    const response = await post(`/api/approvals/${APPROVAL_ID}/approve`, {});

    expect(response.statusCode).toBe(200);
    expect(mockApprove).toHaveBeenCalled();
  });

  it('scopes the ownership check to the session user', async () => {
    ownsIt(true);
    mockRequestChanges.mockResolvedValue('ok');

    await post(`/api/approvals/${APPROVAL_ID}/request-changes`, { feedback: 'x' });

    const guardCall = mockExecute.mock.calls.find(([arg]) =>
      typeof arg === 'object' && String(arg.sql).includes('ag.user_id')
    );
    expect(guardCall).toBeDefined();
    expect(guardCall![0].args).toEqual([APPROVAL_ID, 'user-1']);
  });
});
