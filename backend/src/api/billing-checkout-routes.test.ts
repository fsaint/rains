/**
 * Route tests for POST /api/billing/checkout and the trial.
 *
 * A user who pays during a trial keeps the days they have left: Checkout is
 * sent `subscription_data.trial_end` so the card is saved now and the first
 * charge lands when the trial would have ended. Stripe refuses a trial_end
 * less than 48 hours ahead, so inside that window the user is charged at once
 * (reins spec 2026-09-16 §2.8).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

const { mockExecute, mockGetSession, mockRequireAdmin, mockPending, mockVault, mockApprove, mockCreate, mockCheckAccess, mockGetSubscription } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockGetSession: vi.fn(),
  mockRequireAdmin: vi.fn(),
  mockPending: { store: vi.fn(), get: vi.fn(), del: vi.fn() },
  mockVault: { retrieve: vi.fn(), update: vi.fn(), updateGrantedServices: vi.fn(), storeOAuth: vi.fn() },
  mockApprove: vi.fn(),
  mockCreate: vi.fn(),
  mockCheckAccess: vi.fn(),
  mockGetSubscription: vi.fn(),
}));

vi.mock('stripe', () => ({
  default: class {
    checkout = { sessions: { create: mockCreate } };
    static errors = {};
  },
}));
vi.mock('../services/billing.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/billing.js')>();
  return { ...actual, checkAccess: mockCheckAccess, getSubscription: mockGetSubscription };
});
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

const DAY = 86400000;
let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.STRIPE_BYOK_PRICE_ID = 'price_byok_test';
  process.env.STRIPE_MANAGED_PRICE_ID = 'price_managed_test';
  mockGetSession.mockReturnValue({ userId: 'user-1', email: 'ana@acme.com', role: 'user' });
  mockExecute.mockResolvedValue({ rows: [{ email: 'ana@acme.com' }], rowsAffected: 0, columns: [] });
  mockGetSubscription.mockResolvedValue(null);
  mockCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/c/test' });

  app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(apiRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const checkout = () =>
  app.inject({
    method: 'POST',
    url: '/api/billing/checkout',
    payload: { plan: 'byok', successUrl: 'https://app.helm.mom/billing?ok=1', cancelUrl: 'https://app.helm.mom/pricing' },
  });

function sent() {
  expect(mockCreate).toHaveBeenCalledTimes(1);
  return mockCreate.mock.calls[0][0];
}

describe('POST /api/billing/checkout keeps the trial', () => {
  it('passes trial_end when 48 hours or more of the trial remain', async () => {
    const trialEndsAt = new Date(Date.now() + 20 * DAY).toISOString();
    mockCheckAccess.mockResolvedValue({ allowed: true, trialEndsAt, daysLeft: 20 });

    const res = await checkout();

    expect(res.statusCode).toBe(200);
    expect(res.json().data.url).toBe('https://checkout.stripe.com/c/test');
    const params = sent();
    expect(params.subscription_data.trial_end).toBe(Math.floor(new Date(trialEndsAt).getTime() / 1000));
    expect(params.subscription_data.metadata).toEqual({ userId: 'user-1', plan: 'byok' });
    expect(params.line_items).toEqual([{ price: 'price_byok_test', quantity: 1 }]);
  });

  it('passes trial_end just past the 48 hour line', async () => {
    const trialEndsAt = new Date(Date.now() + 48 * 3600000 + 60000).toISOString();
    mockCheckAccess.mockResolvedValue({ allowed: true, trialEndsAt, daysLeft: 3 });

    await checkout();

    expect(sent().subscription_data.trial_end).toBe(Math.floor(new Date(trialEndsAt).getTime() / 1000));
  });

  it('charges at once when less than 48 hours of the trial remain', async () => {
    const trialEndsAt = new Date(Date.now() + 47 * 3600000).toISOString();
    mockCheckAccess.mockResolvedValue({ allowed: true, trialEndsAt, daysLeft: 2 });

    const res = await checkout();

    expect(res.statusCode).toBe(200);
    expect(sent().subscription_data).not.toHaveProperty('trial_end');
  });

  it('charges at once when the trial has ended', async () => {
    mockCheckAccess.mockResolvedValue({
      allowed: false, reason: 'trial_ended', trialEndsAt: new Date(Date.now() - DAY).toISOString(),
    });

    await checkout();

    expect(sent().subscription_data).not.toHaveProperty('trial_end');
  });

  it('charges at once for a user with no trial', async () => {
    mockCheckAccess.mockResolvedValue({ allowed: true });

    await checkout();

    expect(sent().subscription_data).not.toHaveProperty('trial_end');
  });

  it('gives no fresh trial to a user whose subscription was canceled', async () => {
    mockCheckAccess.mockResolvedValue({ allowed: false, reason: 'subscription_canceled' });
    mockGetSubscription.mockResolvedValue({ stripeCustomerId: 'cus_1', status: 'canceled' });

    await checkout();

    const params = sent();
    expect(params.subscription_data).not.toHaveProperty('trial_end');
    expect(params.customer).toBe('cus_1');
  });
});
