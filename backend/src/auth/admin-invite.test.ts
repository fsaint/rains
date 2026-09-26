/**
 * Route tests for admin invites.
 *
 * An invite creates the account with a trial already running and mails the
 * person a link; they sign in with Google, so no password is ever set. The
 * trial length is the one thing the admin chooses, and it is constrained.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

const { mockExecute, mockSendInvite } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockSendInvite: vi.fn(),
}));

vi.mock('../db/index.js', () => ({ client: { execute: mockExecute } }));
vi.mock('../oauth/pending-flows.js', () => ({
  storePendingOAuthFlow: vi.fn(),
  getPendingOAuthFlow: vi.fn(),
  deletePendingOAuthFlow: vi.fn(),
}));
vi.mock('../analytics/posthog.js', () => ({ getPostHog: () => null }));
vi.mock('../services/email.js', () => ({
  sendInviteEmail: mockSendInvite,
  sendTrialReminderEmail: vi.fn(),
  sendReauthEmail: vi.fn(),
  sendEmail: vi.fn(),
}));
vi.mock('../config/index.js', () => ({
  config: {
    dashboardUrl: 'https://app.helm.mom',
    publicUrl: 'https://app.helm.mom',
    nodeEnv: 'test',
    sessionSecret: 'a'.repeat(40),
    adminApiKey: 'k'.repeat(40),
    googleClientId: 'cid',
    googleClientSecret: 'secret',
    googleLoginRedirectUri: 'https://app.helm.mom/api/auth/google/callback',
    adminEmail: 'admin@helm.mom',
    adminPassword: 'x'.repeat(12),
  },
}));

import { registerAuth } from './index.js';

const ADMIN = { authorization: `Bearer ${'k'.repeat(40)}`, 'content-type': 'application/json' };

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  // No existing user with this email; every other read is empty.
  mockExecute.mockResolvedValue({ rows: [], rowsAffected: 0, columns: [] });
  mockSendInvite.mockResolvedValue(undefined);

  app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(registerAuth);
  await app.ready();
});

const invite = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/admin/users', headers: ADMIN, payload: payload as object });

/** The INSERT this route makes, as { sql, args }. */
function insertCall() {
  const call = mockExecute.mock.calls
    .map((c) => c[0])
    .find((q: any) => typeof q !== 'string' && /INSERT INTO users/i.test(q.sql));
  expect(call, 'expected a users insert').toBeDefined();
  return call as { sql: string; args: unknown[] };
}

describe('POST /api/admin/users — invite with a trial', () => {
  it('creates the account with the trial running and no password', async () => {
    const res = await invite({ email: 'new@acme.com', name: 'Ana Ruiz', trialDays: 30 });

    expect(res.statusCode).toBe(201);
    const { sql, args } = insertCall();
    expect(sql).toContain('trial_ends_at');
    // Password is never set: they sign in with Google. It is a NULL literal in
    // the statement, and no bcrypt hash is passed as an argument.
    expect(sql).toMatch(/password_hash[\s\S]*NULL/);
    expect(args.some((a) => typeof a === 'string' && a.startsWith('$2'))).toBe(false);

    const trialEndsAt = args.find((a) => typeof a === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(a) && new Date(a) > new Date());
    expect(trialEndsAt, 'expected a future trial_ends_at').toBeDefined();
    const days = Math.round((new Date(trialEndsAt as string).getTime() - Date.now()) / 86400000);
    expect(days).toBe(30);

    expect(res.json().data).toMatchObject({ email: 'new@acme.com', name: 'Ana Ruiz' });
    expect(res.json().data.trialEndsAt).toBeTruthy();
  });

  it.each([60, 90])('accepts a %d day trial', async (trialDays) => {
    const res = await invite({ email: `t${trialDays}@acme.com`, name: 'T', trialDays });

    expect(res.statusCode).toBe(201);
    const trialEndsAt = insertCall().args.find(
      (a) => typeof a === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(a) && new Date(a) > new Date()
    );
    const days = Math.round((new Date(trialEndsAt as string).getTime() - Date.now()) / 86400000);
    expect(days).toBe(trialDays);
  });

  it.each([0, 7, 45, 365, -30])('refuses a trial of %d days', async (trialDays) => {
    const res = await invite({ email: 'x@acme.com', name: 'X', trialDays });

    expect(res.statusCode).toBe(400);
    expect(mockExecute.mock.calls.some((c: any) => /INSERT INTO users/i.test(c[0]?.sql ?? ''))).toBe(false);
    expect(mockSendInvite).not.toHaveBeenCalled();
  });

  it('emails the invite with the trial end date', async () => {
    await invite({ email: 'new@acme.com', name: 'Ana Ruiz', trialDays: 60 });

    expect(mockSendInvite).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'new@acme.com', name: 'Ana Ruiz', trialDays: 60 })
    );
  });

  /** A mail outage must not cost the account that was already written. */
  it('still returns the created user when the invite email fails', async () => {
    mockSendInvite.mockRejectedValue(new Error('mailgun down'));

    const res = await invite({ email: 'new@acme.com', name: 'Ana Ruiz', trialDays: 30 });

    expect(res.statusCode).toBe(201);
  });

  it('refuses an address that already has an account', async () => {
    mockExecute.mockImplementation(async (q: any) => {
      const sql: string = typeof q === 'string' ? q : q.sql;
      if (sql.includes('SELECT id FROM users WHERE email')) {
        return { rows: [{ id: 'existing' }], rowsAffected: 1, columns: [] };
      }
      return { rows: [], rowsAffected: 0, columns: [] };
    });

    const res = await invite({ email: 'dupe@acme.com', name: 'D', trialDays: 30 });

    expect(res.statusCode).toBe(409);
    expect(mockSendInvite).not.toHaveBeenCalled();
  });

  it('requires an email and a name', async () => {
    expect((await invite({ name: 'No Email', trialDays: 30 })).statusCode).toBe(400);
    expect((await invite({ email: 'no@name.com', trialDays: 30 })).statusCode).toBe(400);
  });

  it('refuses a caller who is not an admin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'new@acme.com', name: 'A', trialDays: 30 },
    });

    // The auth guard refuses before requireAdmin is reached; either way the
    // request must not create anything.
    expect([401, 403]).toContain(res.statusCode);
    expect(mockExecute.mock.calls.some((c: any) => /INSERT INTO users/i.test(c[0]?.sql ?? ''))).toBe(false);
  });
});
