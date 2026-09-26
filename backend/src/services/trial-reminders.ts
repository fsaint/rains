/**
 * Trial reminders: one warning 7 days before a trial ends, another 1 day
 * before, on email always and Telegram when the user has linked it.
 *
 * An invited user has not linked Telegram at the moment they are created — the
 * invite email asks them to — so email is the channel that must always work
 * and Telegram is the one that may be absent.
 *
 * Each row is stamped BEFORE the message is sent. Stamping afterwards would
 * mean a mail outage re-sends to everyone due, on every hourly tick, for as
 * long as the outage lasts. Losing one reminder is the cheaper failure.
 */

import { client } from '../db/index.js';
import { config } from '../config/index.js';
import { sendTrialReminderEmail } from './email.js';
import { telegramNotifier } from '../notifications/telegram.js';

/** How often the sweep runs. Hourly, matching the other billing crons. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

interface DueUser {
  id: string;
  email: string;
  name: string;
  trial_ends_at: string;
  telegram_chat_id: string | null;
}

/**
 * Users whose trial ends inside `days` and who have not had this reminder.
 *
 * Anyone with a subscription row is excluded outright: they have either paid,
 * in which case the trial is moot, or cancelled, in which case the billing
 * flow owns the conversation and a trial notice would be noise.
 */
async function findDue(days: 7 | 1, stampColumn: string): Promise<DueUser[]> {
  const now = new Date();
  const until = new Date(now.getTime() + days * 86400000);

  const result = await client.execute({
    sql: `SELECT u.id, u.email, u.name, u.trial_ends_at, u.telegram_chat_id
          FROM users u
          WHERE u.status = 'active'
            AND u.trial_ends_at IS NOT NULL
            AND u.trial_ends_at > ?
            AND u.trial_ends_at <= ?
            AND u.${stampColumn} IS NULL
            AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id)
          ORDER BY u.trial_ends_at`,
    args: [now.toISOString(), until.toISOString()],
  });

  return result.rows as unknown as DueUser[];
}

function reminderText(daysLeft: number): string {
  const when = daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
  return (
    `Your Helm free trial ends ${when}. After that your agents stop making tool calls ` +
    `until you pick a plan — your data, memory and settings stay as they are.\n\n` +
    `${config.dashboardUrl.replace(/\/+$/, '')}/pricing`
  );
}

async function remind(user: DueUser, daysLeft: 7 | 1, stampColumn: string): Promise<void> {
  // Stamp first. See the note at the top of this file.
  await client.execute({
    sql: `UPDATE users SET ${stampColumn} = ?, updated_at = ? WHERE id = ?`,
    args: [new Date().toISOString(), new Date().toISOString(), user.id],
  });

  try {
    await sendTrialReminderEmail({
      to: user.email,
      name: user.name,
      daysLeft,
      trialEndsAt: user.trial_ends_at,
      dashboardUrl: config.dashboardUrl,
    });
  } catch (err) {
    console.warn(`[trial-reminders] email to ${user.email} failed:`, err instanceof Error ? err.message : err);
  }

  if (user.telegram_chat_id && telegramNotifier.isConfigured()) {
    try {
      await telegramNotifier.sendToChatId(user.telegram_chat_id, reminderText(daysLeft));
    } catch (err) {
      console.warn(`[trial-reminders] telegram to ${user.email} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

/** Run one sweep. Exported for the cron and for tests. */
export async function sendTrialReminders(): Promise<{ sent7: number; sent1: number }> {
  const windows = [
    { days: 7 as const, column: 'trial_reminder_7_sent_at' },
    { days: 1 as const, column: 'trial_reminder_1_sent_at' },
  ];

  const counts = { sent7: 0, sent1: 0 };
  for (const { days, column } of windows) {
    const due = await findDue(days, column);
    for (const user of due) {
      await remind(user, days, column);
      if (days === 7) counts.sent7++;
      else counts.sent1++;
    }
  }

  if (counts.sent7 || counts.sent1) {
    console.log(`[trial-reminders] sent ${counts.sent7} at 7 days, ${counts.sent1} at 1 day`);
  }
  return counts;
}

/** Start the hourly sweep. Call once at server startup. */
export function startTrialReminderCron(): void {
  const run = () => {
    sendTrialReminders().catch((err) =>
      console.warn('[trial-reminders] sweep failed:', err instanceof Error ? err.message : err)
    );
  };
  setInterval(run, SWEEP_INTERVAL_MS);
  run();
}
