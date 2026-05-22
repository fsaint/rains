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
 * Check if a user can deploy a new agent (strict: requires active subscription).
 * Used by POST /api/agents/create-and-deploy (session-auth path only).
 */
export async function checkDeployGate(userId: string): Promise<GateResult> {
  const sub = await getSubscription(userId);
  if (!sub) return { allowed: false, reason: 'no_subscription' };
  if (sub.status === 'canceled') return { allowed: false, reason: 'canceled' };
  if (sub.status === 'past_due') {
    if (sub.graceUntil && new Date(sub.graceUntil) > new Date()) {
      return { allowed: true };
    }
    return { allowed: false, reason: 'lapsed' };
  }
  return { allowed: true };
}

/**
 * Check if an agent's tool calls should be allowed (lenient: passes if no subscription
 * record exists — handles legacy/onboarding users until they are migrated to paid plans).
 * Used by handleCallTool.
 */
export async function checkUsageGate(userId: string): Promise<GateResult> {
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

/**
 * Find all past_due subscriptions whose grace period has expired,
 * soft-stop all their deployed agents, and return the affected agent IDs.
 * Called by the hourly lapse cron.
 */
export async function softStopLapsedAccounts(): Promise<string[]> {
  const now = new Date().toISOString();
  const lapsed = await client.execute({
    sql: `SELECT user_id FROM subscriptions
          WHERE status = 'past_due' AND grace_until IS NOT NULL AND grace_until < ?`,
    args: [now],
  });
  if (lapsed.rows.length === 0) return [];

  const agentIds: string[] = [];
  for (const row of lapsed.rows) {
    const userId = row.user_id as string;
    const agents = await client.execute({
      sql: `UPDATE deployed_agents
            SET spend_soft_stopped = 1, updated_at = ?
            WHERE agent_id IN (SELECT id FROM agents WHERE user_id = ?)
              AND status = 'running'
              AND spend_soft_stopped = 0
            RETURNING agent_id`,
      args: [now, userId],
    });
    for (const a of agents.rows) agentIds.push(a.agent_id as string);
  }
  return agentIds;
}

/** Start the hourly lapse-enforcement cron. Call once at server startup. */
export function startLapseCron(): void {
  const run = async () => {
    try {
      const stopped = await softStopLapsedAccounts();
      if (stopped.length > 0) {
        console.log(`[billing-cron] soft-stopped ${stopped.length} agents for lapsed subscriptions`);
      }
    } catch (e) {
      console.warn('[billing-cron] error:', e instanceof Error ? e.message : e);
    }
  };
  setInterval(run, 60 * 60 * 1000); // every hour
  run(); // also run immediately on startup
}
