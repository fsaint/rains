import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../db/index.js', () => ({
  client: { execute: vi.fn() },
}));

vi.mock('nanoid', () => ({
  nanoid: () => 'test-id',
}));

import { client } from '../db/index.js';
import {
  getSubscription,
  upsertSubscription,
  checkAccess,
  applyGracePeriod,
  clearGrace,
  cancelSubscription,
} from './billing.js';

const mockExecute = vi.mocked(client.execute);

const activeRow = {
  id: 'sub-1',
  user_id: 'user-1',
  stripe_customer_id: 'cus_abc',
  stripe_subscription_id: 'sub_abc',
  plan: 'byok',
  status: 'active',
  current_period_end: '2026-06-22T00:00:00.000Z',
  grace_until: null,
};

function mockQuery(rows: Record<string, unknown>[]) {
  mockExecute.mockResolvedValueOnce({
    rows,
    rowsAffected: rows.length,
    lastInsertRowid: 0n,
    columns: [],
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// getSubscription
// ---------------------------------------------------------------------------

describe('getSubscription', () => {
  it('returns null when no subscription exists', async () => {
    mockQuery([]);
    const result = await getSubscription('user-1');
    expect(result).toBeNull();
    expect(mockExecute).toHaveBeenCalledOnce();
  });

  it('maps db row to Subscription object with camelCase fields', async () => {
    mockQuery([activeRow]);
    const sub = await getSubscription('user-1');
    expect(sub).not.toBeNull();
    expect(sub?.id).toBe('sub-1');
    expect(sub?.userId).toBe('user-1');
    expect(sub?.stripeCustomerId).toBe('cus_abc');
    expect(sub?.stripeSubscriptionId).toBe('sub_abc');
    expect(sub?.plan).toBe('byok');
    expect(sub?.status).toBe('active');
    expect(sub?.currentPeriodEnd).toBe('2026-06-22T00:00:00.000Z');
    expect(sub?.graceUntil).toBeNull();
  });

  it('handles null stripe_subscription_id and grace_until', async () => {
    mockQuery([{ ...activeRow, stripe_subscription_id: null, grace_until: null }]);
    const sub = await getSubscription('user-1');
    expect(sub?.stripeSubscriptionId).toBeNull();
    expect(sub?.graceUntil).toBeNull();
  });

  it('queries with correct user_id', async () => {
    mockQuery([]);
    await getSubscription('user-123');
    expect(mockExecute).toHaveBeenCalledWith({
      sql: expect.stringContaining('WHERE user_id = ? LIMIT 1'),
      args: ['user-123'],
    });
  });
});

// ---------------------------------------------------------------------------
// upsertSubscription
// ---------------------------------------------------------------------------

describe('upsertSubscription', () => {
  it('inserts new subscription when user has no existing record', async () => {
    mockQuery([]); // getSubscription returns empty
    mockQuery([]); // INSERT succeeds
    await upsertSubscription({
      userId: 'user-1',
      stripeCustomerId: 'cus_new',
      plan: 'managed',
      status: 'active',
      currentPeriodEnd: '2026-07-01T00:00:00Z',
    });

    expect(mockExecute).toHaveBeenCalledTimes(2); // getSubscription + INSERT
    const insertCall = mockExecute.mock.calls[1][0] as any;
    expect(insertCall.sql).toContain('INSERT INTO subscriptions');
    expect(insertCall.args[1]).toBe('user-1'); // user_id
    expect(insertCall.args[2]).toBe('cus_new'); // stripe_customer_id
    expect(insertCall.args[4]).toBe('managed'); // plan
    expect(insertCall.args[5]).toBe('active'); // status
  });

  it('updates existing subscription', async () => {
    mockQuery([activeRow]); // getSubscription returns existing
    mockQuery([]); // UPDATE succeeds
    await upsertSubscription({
      userId: 'user-1',
      stripeCustomerId: 'cus_updated',
      plan: 'managed',
      status: 'past_due',
    });

    expect(mockExecute).toHaveBeenCalledTimes(2); // getSubscription + UPDATE
    const updateCall = mockExecute.mock.calls[1][0] as any;
    expect(updateCall.sql).toContain('UPDATE subscriptions SET');
    expect(updateCall.args[0]).toBe('cus_updated'); // stripe_customer_id
    expect(updateCall.args[3]).toBe('past_due'); // status
    expect(updateCall.args[6]).toBe('user-1'); // WHERE user_id
  });

  it('preserves existing stripe_subscription_id on update if not provided', async () => {
    mockQuery([activeRow]); // has stripe_subscription_id = 'sub_abc'
    mockQuery([]); // UPDATE succeeds
    await upsertSubscription({
      userId: 'user-1',
      stripeCustomerId: 'cus_updated',
      plan: 'managed',
      status: 'active',
      // stripeSubscriptionId not provided
    });

    const updateCall = mockExecute.mock.calls[1][0] as any;
    expect(updateCall.sql).toContain('COALESCE(?, stripe_subscription_id)');
    expect(updateCall.args[1]).toBeNull(); // null argument, COALESCE preserves old value
  });

  it('preserves existing current_period_end on update if not provided', async () => {
    mockQuery([activeRow]);
    mockQuery([]);
    await upsertSubscription({
      userId: 'user-1',
      stripeCustomerId: 'cus_updated',
      plan: 'managed',
      status: 'active',
      // currentPeriodEnd not provided
    });

    const updateCall = mockExecute.mock.calls[1][0] as any;
    expect(updateCall.sql).toContain('COALESCE(?, current_period_end)');
    expect(updateCall.args[4]).toBeNull(); // null argument, COALESCE preserves old value
  });
});


// ---------------------------------------------------------------------------
// applyGracePeriod
// ---------------------------------------------------------------------------

describe('applyGracePeriod', () => {
  it('sets status to past_due and grace_until to ~3 days from now', async () => {
    mockQuery([]);
    const before = Date.now();
    await applyGracePeriod('sub_abc');
    const after = Date.now();

    expect(mockExecute).toHaveBeenCalledOnce();
    const call = mockExecute.mock.calls[0][0] as any;
    expect(call.sql).toContain("status = 'past_due'");
    expect(call.sql).toContain('grace_until = ?');
    expect(call.sql).toContain('stripe_subscription_id = ?');

    const graceUntil = new Date(call.args[0] as string).getTime();
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

    // grace_until was computed at some instant t with before <= t <= after, so
    // the offset is bounded exactly by those two. This replaces a ±100ms fudge
    // that would go flaky on a slow runner.
    expect(graceUntil - after).toBeGreaterThanOrEqual(threeDaysMs - 1);
    expect(graceUntil - before).toBeLessThanOrEqual(threeDaysMs + 1);
  });

  it('updates with correct stripe_subscription_id', async () => {
    mockQuery([]);
    await applyGracePeriod('sub_xyz');
    const call = mockExecute.mock.calls[0][0] as any;
    expect(call.args[2]).toBe('sub_xyz');
  });
});

// ---------------------------------------------------------------------------
// clearGrace
// ---------------------------------------------------------------------------

describe('clearGrace', () => {
  it('sets status to active and clears grace_until', async () => {
    mockQuery([]);
    await clearGrace('sub_abc');

    expect(mockExecute).toHaveBeenCalledOnce();
    const call = mockExecute.mock.calls[0][0] as any;
    expect(call.sql).toContain("status = 'active'");
    expect(call.sql).toContain('grace_until = NULL');
    expect(call.sql).toContain('stripe_subscription_id = ?');
  });

  it('updates with correct stripe_subscription_id', async () => {
    mockQuery([]);
    await clearGrace('sub_xyz');
    const call = mockExecute.mock.calls[0][0] as any;
    expect(call.args[1]).toBe('sub_xyz');
  });
});

// ---------------------------------------------------------------------------
// cancelSubscription
// ---------------------------------------------------------------------------

describe('cancelSubscription', () => {
  it('sets status to canceled', async () => {
    mockQuery([]);
    await cancelSubscription('sub_abc');

    expect(mockExecute).toHaveBeenCalledOnce();
    const call = mockExecute.mock.calls[0][0] as any;
    expect(call.sql).toContain("status = 'canceled'");
    expect(call.sql).toContain('stripe_subscription_id = ?');
  });

  it('updates with correct stripe_subscription_id', async () => {
    mockQuery([]);
    await cancelSubscription('sub_xyz');
    const call = mockExecute.mock.calls[0][0] as any;
    expect(call.args[1]).toBe('sub_xyz');
  });
});


// ---------------------------------------------------------------------------
// checkAccess — the single gate: subscription OR live trial
// ---------------------------------------------------------------------------

/**
 * Serves the user row and the subscription row by which table the query names,
 * so these do not depend on the order checkAccess reads them in.
 */
function mockAccessRows(opts: { user?: Record<string, unknown> | null; sub?: Record<string, unknown> | null }) {
  const { user = { role: 'user', trial_ends_at: null }, sub = null } = opts;
  mockExecute.mockImplementation(async (q: any) => {
    const sql: string = typeof q === 'string' ? q : q.sql;
    const rows = (r: unknown[]) => ({ rows: r, rowsAffected: r.length, lastInsertRowid: 0n, columns: [] }) as any;
    if (sql.includes('FROM users')) return rows(user ? [user] : []);
    if (sql.includes('FROM subscriptions')) return rows(sub ? [sub] : []);
    return rows([]);
  });
}

const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString();

describe('checkAccess', () => {
  it('allows an active subscription regardless of any trial', async () => {
    mockAccessRows({ user: { role: 'user', trial_ends_at: inDays(-30) }, sub: activeRow });
    expect(await checkAccess('user-1')).toEqual({ allowed: true });
  });

  it('allows a live trial when there is no subscription', async () => {
    mockAccessRows({ user: { role: 'user', trial_ends_at: inDays(5) } });
    const result = await checkAccess('user-1');
    expect(result.allowed).toBe(true);
    expect(result.trialEndsAt).toBeTruthy();
    expect(result.daysLeft).toBe(5);
  });

  it('blocks once the trial has passed with no subscription', async () => {
    mockAccessRows({ user: { role: 'user', trial_ends_at: inDays(-1) } });
    expect(await checkAccess('user-1')).toMatchObject({ allowed: false, reason: 'trial_ended' });
  });

  /** Everyone who predates trials keeps working; a null date is not an expired one. */
  it('allows a user with no trial date and no subscription', async () => {
    mockAccessRows({ user: { role: 'user', trial_ends_at: null } });
    expect(await checkAccess('user-1')).toEqual({ allowed: true });
  });

  it('never locks out an admin', async () => {
    mockAccessRows({ user: { role: 'admin', trial_ends_at: inDays(-90) } });
    expect(await checkAccess('user-1')).toEqual({ allowed: true });
  });

  it('blocks a lapsed subscription past its grace period', async () => {
    mockAccessRows({ user: { role: 'user', trial_ends_at: null }, sub: { ...activeRow, status: 'past_due', grace_until: inDays(-1) } });
    expect(await checkAccess('user-1')).toMatchObject({ allowed: false, reason: 'subscription_lapsed' });
  });

  it('allows a lapsed subscription still inside its grace period', async () => {
    mockAccessRows({ user: { role: 'user', trial_ends_at: null }, sub: { ...activeRow, status: 'past_due', grace_until: inDays(2) } });
    expect(await checkAccess('user-1')).toEqual({ allowed: true });
  });

  /** Cancelling is a decision; a trial still running does not undo it. */
  it('blocks a cancelled subscription even inside a live trial', async () => {
    mockAccessRows({ user: { role: 'user', trial_ends_at: inDays(10) }, sub: { ...activeRow, status: 'canceled' } });
    expect(await checkAccess('user-1')).toMatchObject({ allowed: false, reason: 'subscription_canceled' });
  });

  it('blocks an unknown user rather than letting them through', async () => {
    mockAccessRows({ user: null });
    expect(await checkAccess('nobody')).toMatchObject({ allowed: false });
  });

  it('honours the billing bypass used by the e2e job', async () => {
    const prev = process.env.BYPASS_BILLING;
    process.env.BYPASS_BILLING = 'true';
    mockAccessRows({ user: { role: 'user', trial_ends_at: inDays(-5) } });
    expect(await checkAccess('user-1')).toEqual({ allowed: true });
    process.env.BYPASS_BILLING = prev;
  });
});
