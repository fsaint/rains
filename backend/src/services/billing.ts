import { nanoid } from 'nanoid';
import { client } from '../db/index.js';

export type Plan = 'byok' | 'managed';
export type SubStatus = 'active' | 'past_due' | 'canceled';

export interface Subscription {
  id: string;
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  plan: Plan;
  status: SubStatus;
  currentPeriodEnd: string | null;
  graceUntil: string | null;
}

export interface GateResult {
  allowed: boolean;
  reason?: 'no_subscription' | 'lapsed' | 'canceled';
}

function mapRow(row: Record<string, unknown>): Subscription {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    stripeCustomerId: row.stripe_customer_id as string,
    stripeSubscriptionId: row.stripe_subscription_id as string | null,
    plan: row.plan as Plan,
    status: row.status as SubStatus,
    currentPeriodEnd: row.current_period_end as string | null,
    graceUntil: row.grace_until as string | null,
  };
}

/** Returns the user's subscription, or null if they have none. */
export async function getSubscription(userId: string): Promise<Subscription | null> {
  const result = await client.execute({
    sql: `SELECT * FROM subscriptions WHERE user_id = ? LIMIT 1`,
    args: [userId],
  });
  if (result.rows.length === 0) return null;
  return mapRow(result.rows[0]);
}

/** Upsert a subscription row (insert or update on user_id conflict). */
export async function upsertSubscription(data: {
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId?: string;
  plan: Plan;
  status: SubStatus;
  currentPeriodEnd?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const existing = await getSubscription(data.userId);
  if (existing) {
    await client.execute({
      sql: `UPDATE subscriptions SET
              stripe_customer_id = ?,
              stripe_subscription_id = COALESCE(?, stripe_subscription_id),
              plan = ?,
              status = ?,
              current_period_end = COALESCE(?, current_period_end),
              updated_at = ?
            WHERE user_id = ?`,
      args: [
        data.stripeCustomerId,
        data.stripeSubscriptionId ?? null,
        data.plan,
        data.status,
        data.currentPeriodEnd ?? null,
        now,
        data.userId,
      ],
    });
  } else {
    await client.execute({
      sql: `INSERT INTO subscriptions
              (id, user_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_end, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        nanoid(),
        data.userId,
        data.stripeCustomerId,
        data.stripeSubscriptionId ?? null,
        data.plan,
        data.status,
        data.currentPeriodEnd ?? null,
        now,
        now,
      ],
    });
  }
}

/**
 * Check if an agent's tool calls should be allowed (lenient: passes if no subscription
 * record exists — handles legacy/onboarding users until they are migrated to paid plans).
 * Used by handleCallTool.
 */
export async function checkUsageGate(userId: string): Promise<GateResult> {
  if (process.env.BYPASS_BILLING === 'true') return { allowed: true };
  const sub = await getSubscription(userId);
  if (!sub) return { allowed: true }; // no record = legacy user, allow through
  if (sub.status === 'active') return { allowed: true };
  if (sub.status === 'past_due') {
    if (sub.graceUntil && new Date(sub.graceUntil) > new Date()) {
      return { allowed: true };
    }
    return { allowed: false, reason: 'lapsed' };
  }
  return { allowed: false, reason: 'canceled' };
}

/** Set grace_until to 3 days from now and status to past_due. */
export async function applyGracePeriod(stripeSubscriptionId: string): Promise<void> {
  const graceUntil = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  await client.execute({
    sql: `UPDATE subscriptions
          SET status = 'past_due', grace_until = ?, updated_at = ?
          WHERE stripe_subscription_id = ?`,
    args: [graceUntil, new Date().toISOString(), stripeSubscriptionId],
  });
}

/** Clear grace period and restore active status on payment recovery. */
export async function clearGrace(stripeSubscriptionId: string): Promise<void> {
  await client.execute({
    sql: `UPDATE subscriptions
          SET status = 'active', grace_until = NULL, updated_at = ?
          WHERE stripe_subscription_id = ?`,
    args: [new Date().toISOString(), stripeSubscriptionId],
  });
}

/** Mark subscription canceled. */
export async function cancelSubscription(stripeSubscriptionId: string): Promise<void> {
  await client.execute({
    sql: `UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE stripe_subscription_id = ?`,
    args: [new Date().toISOString(), stripeSubscriptionId],
  });
}
