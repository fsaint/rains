/**
 * Route tests for Google self-enrollment (reins spec 2026-09-16 §2.5).
 *
 * helm.mom's "Start for $19 a month" sends a stranger to app.helm.mom. With
 * self-enrollment on, their first Google sign-in creates the account with a
 * 15-day trial and a welcome email. With it off, they are refused as before.
 * A suspended or deleted account is never re-created, so an email cannot earn
 * a second trial.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

const { mockExecute, mockSendWelcome, mockGetPending, mockCapture, mockConfig } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockSendWelcome: vi.fn(),
  mockGetPending: vi.fn(),
  mockCapture: vi.fn(),
  mockConfig: {
    dashboardUrl: 'https://app.helm.mom',
    publicUrl: 'https://app.helm.mom',
    nodeEnv: 'test',
    sessionSecret: 'a'.repeat(40),
    googleClientId: 'cid',
    googleClientSecret: 'secret',
    googleLoginRedirectUri: 'https://app.helm.mom/api/auth/google/callback',
    adminPassword: 'x'.repeat(12),
    enrollment: { selfEnroll: true, selfTrialDays: 15 },
  },
}));

vi.mock('../db/index.js', () => ({ client: { execute: mockExecute } }));
vi.mock('../oauth/pending-flows.js', () => ({
  storePendingOAuthFlow: vi.fn(),
  getPendingOAuthFlow: mockGetPending,
  deletePendingOAuthFlow: vi.fn(),
}));
vi.mock('../analytics/posthog.js', () => ({ getPostHog: () => ({ capture: mockCapture }) }));
vi.mock('../services/email.js', () => ({
  sendInviteEmail: vi.fn(),
  sendWelcomeEmail: mockSendWelcome,
  sendTrialReminderEmail: vi.fn(),
  sendReauthEmail: vi.fn(),
  sendEmail: vi.fn(),
}));
vi.mock('../config/index.js', () => ({ config: mockConfig }));

import { registerAuth, verifySession } from './index.js';

let app: FastifyInstance;

/** Google's token exchange, then its userinfo for `profile`. */
function googleAnswers(profile: Record<string, string>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'at' }), { status: 200 });
    }
    if (String(url).includes('/oauth2/v2/userinfo')) {
      return new Response(JSON.stringify(profile), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
}

/** The users lookup answers with `rows`; everything else is empty. */
function existingUser(rows: Record<string, unknown>[]) {
  mockExecute.mockImplementation(async (q: any) => {
    const sql = typeof q === 'string' ? q : q.sql;
    if (/SELECT .* FROM users WHERE email/i.test(sql)) return { rows, rowsAffected: 0, columns: [] };
    return { rows: [], rowsAffected: 1, columns: [] };
  });
}

function insertCall() {
  return mockExecute.mock.calls
    .map((c) => c[0])
    .find((q: any) => typeof q !== 'string' && /INSERT INTO users/i.test(q.sql)) as
    | { sql: string; args: unknown[] }
    | undefined;
}

const callback = () =>
  app.inject({ method: 'GET', url: '/api/auth/google/callback?code=c&state=s' });

const STRANGER = { email: 'ana@acme.com', name: 'Ana Ruiz', given_name: 'Ana', family_name: 'Ruiz' };

beforeEach(async () => {
  vi.clearAllMocks();
  mockConfig.enrollment = { selfEnroll: true, selfTrialDays: 15 };
  mockGetPending.mockResolvedValue({ service: 'google_login' });
  mockSendWelcome.mockResolvedValue(undefined);
  existingUser([]);
  googleAnswers(STRANGER);

  app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(registerAuth);
  await app.ready();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

describe('Google sign-in from an unknown email', () => {
  it('creates the account with first and last name, no password and a 15-day trial', async () => {
    const res = await callback();

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://app.helm.mom');

    const insert = insertCall();
    expect(insert, 'expected a users insert').toBeDefined();
    expect(insert!.sql).toMatch(/first_name/);
    expect(insert!.sql).toMatch(/last_name/);
    expect(insert!.sql).toMatch(/password_hash[\s\S]*NULL/);
    expect(insert!.sql).toMatch(/'user', 'active'/);
    const [, email, name, first, last, trialEndsAt] = insert!.args as string[];
    expect({ email, name, first, last }).toEqual({ email: 'ana@acme.com', name: 'Ana Ruiz', first: 'Ana', last: 'Ruiz' });
    const days = (new Date(trialEndsAt).getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(14.99);
    expect(days).toBeLessThanOrEqual(15);
  });

  it('signs the new user in', async () => {
    const res = await callback();

    const cookieHeader = String(res.headers['set-cookie']);
    const token = /reins_session=([^;]+)/.exec(cookieHeader)?.[1];
    expect(token).toBeTruthy();
    const session = verifySession(token!);
    expect(session).toMatchObject({ email: 'ana@acme.com', role: 'user' });
    expect(session!.userId).toBe(insertCall()!.args[0]);
  });

  it('sends the welcome email with the trial and records the enrollment', async () => {
    await callback();

    expect(mockSendWelcome).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ana@acme.com', firstName: 'Ana', trialDays: 15, dashboardUrl: 'https://app.helm.mom' })
    );
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'user_enrolled', properties: expect.objectContaining({ method: 'google' }) })
    );
  });

  it('uses the configured trial length', async () => {
    mockConfig.enrollment = { selfEnroll: true, selfTrialDays: 30 };

    await callback();

    const trialEndsAt = insertCall()!.args[5] as string;
    expect(Math.round((new Date(trialEndsAt).getTime() - Date.now()) / 86400000)).toBe(30);
  });

  it('still signs in when the welcome email fails', async () => {
    mockSendWelcome.mockRejectedValue(new Error('mailgun down'));

    const res = await callback();

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://app.helm.mom');
    expect(String(res.headers['set-cookie'])).toContain('reins_session=');
  });

  it('returns to the page the stranger started from, such as /pricing', async () => {
    mockGetPending.mockResolvedValue({ service: 'google_login', returnTo: 'https://app.helm.mom/pricing' });

    const res = await callback();

    expect(res.headers.location).toBe('https://app.helm.mom/pricing');
  });

  it('falls back to Google\'s full name, then the email, when names are missing', async () => {
    googleAnswers({ email: 'solo@acme.com' });

    await callback();

    const [, , name, first, last] = insertCall()!.args;
    expect(name).toBe('solo');
    expect(first).toBeNull();
    expect(last).toBeNull();
  });

  it('refuses the stranger when self-enrollment is off', async () => {
    mockConfig.enrollment = { selfEnroll: false, selfTrialDays: 15 };

    const res = await callback();

    expect(res.headers.location).toBe('https://app.helm.mom/?login_error=not_authorized');
    expect(insertCall()).toBeUndefined();
    expect(mockSendWelcome).not.toHaveBeenCalled();
  });
});

describe('Google sign-in from a known email', () => {
  it('signs an active user in without creating anything', async () => {
    existingUser([{ id: 'u1', email: 'ana@acme.com', name: 'Ana Ruiz', role: 'user', status: 'active' }]);

    const res = await callback();

    expect(res.headers.location).toBe('https://app.helm.mom');
    expect(insertCall()).toBeUndefined();
    expect(mockSendWelcome).not.toHaveBeenCalled();
  });

  it.each(['deleted', 'suspended'])('refuses a %s user and does not re-enroll them', async (status) => {
    existingUser([{ id: 'u1', email: 'ana@acme.com', name: 'Ana Ruiz', role: 'user', status }]);

    const res = await callback();

    expect(res.headers.location).toBe('https://app.helm.mom/?login_error=not_authorized');
    expect(insertCall()).toBeUndefined();
    expect(mockSendWelcome).not.toHaveBeenCalled();
    expect(String(res.headers['set-cookie'] ?? '')).not.toContain('reins_session=');
  });

  it('looks the email up whatever its status', async () => {
    await callback();

    const lookup = mockExecute.mock.calls
      .map((c) => c[0])
      .find((q: any) => /FROM users WHERE email/i.test(q?.sql ?? ''));
    expect(lookup.sql).not.toMatch(/status\s*=\s*'active'/);
  });
});
