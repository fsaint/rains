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
  checkDeployGate,
  checkUsageGate,
  applyGracePeriod,
  clearGrace,
  cancelSubscription,
  softStopLapsedAccounts,
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
// checkDeployGate
// ---------------------------------------------------------------------------

describe('checkDeployGate', () => {
  it('blocks when no subscription exists', async () => {
    mockQuery([]);
    const result = await checkDeployGate('user-1');
    expect(result).toEqual({ allowed: false, reason: 'no_subscription' });
  });

  it('allows when status is active', async () => {
    mockQuery([activeRow]);
    const result = await checkDeployGate('user-1');
    expect(result).toEqual({ allowed: true });
  });

  it('blocks when status is canceled', async () => {
    mockQuery([{ ...activeRow, status: 'canceled' }]);
    const result = await checkDeployGate('user-1');
    expect(result).toEqual({ allowed: false, reason: 'canceled' });
  });

  it('allows when past_due within grace period', async () => {
    const graceUntil = new Date(Date.now() + 60_000).toISOString();
    mockQuery([{ ...activeRow, status: 'past_due', grace_until: graceUntil }]);
    const result = await checkDeployGate('user-1');
    expect(result).toEqual({ allowed: true });
  });

  it('blocks when past_due and grace period expired', async () => {
    const graceUntil = new Date(Date.now() - 60_000).toISOString();
    mockQuery([{ ...activeRow, status: 'past_due', grace_until: graceUntil }]);
    const result = await checkDeployGate('user-1');
    expect(result).toEqual({ allowed: false, reason: 'lapsed' });
  });

  it('blocks when past_due with no grace_until set', async () => {
    mockQuery([{ ...activeRow, status: 'past_due', grace_until: null }]);
    const result = await checkDeployGate('user-1');
    expect(result).toEqual({ allowed: false, reason: 'lapsed' });
  });
});

// ---------------------------------------------------------------------------
// checkUsageGate
// ---------------------------------------------------------------------------

describe('checkUsageGate', () => {
  it('allows when no subscription (legacy user)', async () => {
    mockQuery([]);
    const result = await checkUsageGate('user-1');
    expect(result).toEqual({ allowed: true });
  });

  it('allows when status is active', async () => {
    mockQuery([activeRow]);
    const result = await checkUsageGate('user-1');
    expect(result).toEqual({ allowed: true });
  });

  it('blocks when status is canceled', async () => {
    mockQuery([{ ...activeRow, status: 'canceled' }]);
    const result = await checkUsageGate('user-1');
    expect(result).toEqual({ allowed: false, reason: 'canceled' });
  });

  it('allows when past_due within grace period', async () => {
    const graceUntil = new Date(Date.now() + 60_000).toISOString();
    mockQuery([{ ...activeRow, status: 'past_due', grace_until: graceUntil }]);
    const result = await checkUsageGate('user-1');
    expect(result).toEqual({ allowed: true });
  });

  it('blocks when past_due and grace period expired', async () => {
    const graceUntil = new Date(Date.now() - 60_000).toISOString();
    mockQuery([{ ...activeRow, status: 'past_due', grace_until: graceUntil }]);
    const result = await checkUsageGate('user-1');
    expect(result).toEqual({ allowed: false, reason: 'lapsed' });
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
    const diffMs = graceUntil - before;
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

    // Allow 100ms of tolerance on either side
    expect(diffMs).toBeGreaterThan(threeDaysMs - 100);
    expect(diffMs).toBeLessThan(threeDaysMs + 100);
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
// softStopLapsedAccounts
// ---------------------------------------------------------------------------

describe('softStopLapsedAccounts', () => {
  it('returns empty array when no lapsed subscriptions', async () => {
    mockQuery([]); // No lapsed subs
    const result = await softStopLapsedAccounts();
    expect(result).toEqual([]);
    expect(mockExecute).toHaveBeenCalledOnce();
  });

  it('soft-stops agents for lapsed users and returns agent IDs', async () => {
    mockQuery([{ user_id: 'user-1' }]); // One lapsed user
    mockQuery([{ agent_id: 'agent-a' }, { agent_id: 'agent-b' }]); // Two agents to stop

    const result = await softStopLapsedAccounts();

    expect(result).toEqual(['agent-a', 'agent-b']);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it('updates deployed_agents with spend_soft_stopped = 1 for lapsed users', async () => {
    mockQuery([{ user_id: 'user-1' }]);
    mockQuery([{ agent_id: 'agent-a' }]);

    await softStopLapsedAccounts();

    const updateCall = mockExecute.mock.calls[1][0] as any;
    expect(updateCall.sql).toContain('UPDATE deployed_agents');
    expect(updateCall.sql).toContain('spend_soft_stopped = 1');
    expect(updateCall.sql).toContain('WHERE agent_id IN');
    expect(updateCall.sql).toContain('SELECT id FROM agents WHERE user_id = ?');
    expect(updateCall.args[1]).toBe('user-1');
  });

  it('handles multiple lapsed users', async () => {
    mockQuery([{ user_id: 'user-1' }, { user_id: 'user-2' }]);
    mockQuery([{ agent_id: 'agent-a' }]);
    mockQuery([{ agent_id: 'agent-b' }, { agent_id: 'agent-c' }]);

    const result = await softStopLapsedAccounts();

    expect(result).toEqual(['agent-a', 'agent-b', 'agent-c']);
    expect(mockExecute).toHaveBeenCalledTimes(3); // SELECT lapsed + UPDATE for user-1 + UPDATE for user-2
  });

  it('includes only running agents not already soft-stopped', async () => {
    mockQuery([{ user_id: 'user-1' }]);
    mockQuery([{ agent_id: 'agent-a' }]);

    await softStopLapsedAccounts();

    const updateCall = mockExecute.mock.calls[1][0] as any;
    expect(updateCall.sql).toContain('status = \'running\'');
    expect(updateCall.sql).toContain('spend_soft_stopped = 0');
  });
});
