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

export type AccessDenial = 'trial_ended' | 'subscription_lapsed' | 'subscription_canceled' | 'unknown_user';

export interface AccessResult {
  allowed: boolean;
  reason?: AccessDenial;
  /** Present while a trial is the thing granting access. */
  trialEndsAt?: string;
  daysLeft?: number;
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
 * The single question: may this user's agents call tools right now?
 *
 * Access comes from an active subscription OR a trial that has not run out.
 * Order matters and is deliberate:
 *
 *  - An admin is never locked out of their own platform.
 *  - A cancelled subscription blocks even inside a live trial. Cancelling is a
 *    decision, and a trial does not undo it.
 *  - A user with no trial date and no subscription is allowed. Everyone who
 *    predates trials falls here, and a missing date is not an expired one.
 *  - An unknown user is refused rather than waved through.
 *
 * The dashboard is deliberately NOT gated on this: someone whose trial ended
 * has to be able to sign in and pay.
 */
export async function checkAccess(userId: string): Promise<AccessResult> {
  if (process.env.BYPASS_BILLING === 'true') return { allowed: true };

  const userRow = await client.execute({
    sql: `SELECT role, trial_ends_at FROM users WHERE id = ? LIMIT 1`,
    args: [userId],
  });
  const user = userRow.rows[0];
  if (!user) return { allowed: false, reason: 'unknown_user' };
  if (user.role === 'admin') return { allowed: true };

  const sub = await getSubscription(userId);
  if (sub) {
    if (sub.status === 'active') return { allowed: true };
    if (sub.status === 'canceled') return { allowed: false, reason: 'subscription_canceled' };
    if (sub.status === 'past_due') {
      const inGrace = !!sub.graceUntil && new Date(sub.graceUntil) > new Date();
      return inGrace ? { allowed: true } : { allowed: false, reason: 'subscription_lapsed' };
    }
  }

  const trialEndsAt = user.trial_ends_at as string | null;
  if (!trialEndsAt) return { allowed: true };

  const endsAt = new Date(trialEndsAt);
  if (Number.isNaN(endsAt.getTime())) return { allowed: true };
  if (endsAt <= new Date()) return { allowed: false, reason: 'trial_ended', trialEndsAt };

  return { allowed: true, trialEndsAt, daysLeft: daysUntil(trialEndsAt) };
}

/** Whole days from now until `iso`, rounded up; never negative. */
export function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / 86400000);
}

/** Stripe refuses a Checkout `subscription_data.trial_end` less than 48 hours ahead. */
export const MIN_CHECKOUT_TRIAL_MS = 48 * 60 * 60 * 1000;

/**
 * The `subscription_data.trial_end` to send to Stripe Checkout, as a unix
 * timestamp, or undefined to charge at once.
 *
 * A user who pays during a trial keeps the days they have left: the card is
 * saved now and the first charge lands when the trial would have ended. Stripe
 * requires the date to be at least 48 hours ahead, so a trial closer to its end
 * than that is charged straight away (reins spec 2026-09-16 §2.8).
 */
export function checkoutTrialEnd(trialEndsAt: string | undefined | null, now: number = Date.now()): number | undefined {
  if (!trialEndsAt) return undefined;
  const endsMs = new Date(trialEndsAt).getTime();
  if (Number.isNaN(endsMs)) return undefined;
  if (endsMs - now < MIN_CHECKOUT_TRIAL_MS) return undefined;
  return Math.floor(endsMs / 1000);
}
