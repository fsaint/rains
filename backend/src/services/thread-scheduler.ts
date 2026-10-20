/**
 * Thread reminder scheduler: every minute, claim the thread items that have
 * come due and tell the owner on Telegram and iOS push.
 *
 * A claim is one UPDATE ... RETURNING that stamps the rows before anything is
 * sent. Two ticks can never claim the same item, and a Telegram or APNs outage
 * costs one reminder instead of re-sending on every tick. Paused threads are
 * filtered out of the claim, so items that fall due during a pause stay
 * unstamped and fire on the first tick after resume.
 */

import { client } from '../db/index.js';
import { config } from '../config/index.js';
import { telegramNotifier } from '../notifications/telegram.js';
import { apnsService } from '../notifications/apns.js';
import { runWatcherSweep } from './thread-watchers.js';

const TICK_INTERVAL_MS = 60_000;
const WATCHER_SWEEP_INTERVAL_MS = 15 * 60_000;

interface ClaimedItem {
  id: string;
  thread_id: string;
  title: string;
  due_at: string | null;
  thread_title: string;
  user_id: string;
}

/** Items whose reminder time has passed. A `reminder` is finished by its nudge. */
async function claimNudges(nowIso: string): Promise<ClaimedItem[]> {
  const result = await client.execute({
    sql: `UPDATE thread_items i
          SET nudge_fired_at = ?,
              fired_at = CASE WHEN i.kind = 'reminder' THEN ? ELSE i.fired_at END
          FROM threads t
          WHERE t.id = i.thread_id AND t.status = 'active' AND i.status = 'open'
            AND i.remind_at IS NOT NULL AND i.remind_at <= ? AND i.nudge_fired_at IS NULL
          RETURNING i.*, t.title AS thread_title, t.user_id`,
    args: [nowIso, nowIso, nowIso],
  });
  return result.rows as unknown as ClaimedItem[];
}

/** Deadlines, todos and milestones whose due time has passed. */
async function claimDues(nowIso: string): Promise<ClaimedItem[]> {
  const result = await client.execute({
    sql: `UPDATE thread_items i
          SET fired_at = ?
          FROM threads t
          WHERE t.id = i.thread_id AND t.status = 'active' AND i.status = 'open'
            AND i.kind IN ('deadline','todo','milestone')
            AND i.due_at IS NOT NULL AND i.due_at <= ? AND i.fired_at IS NULL
          RETURNING i.*, t.title AS thread_title, t.user_id`,
    args: [nowIso, nowIso],
  });
  return result.rows as unknown as ClaimedItem[];
}

async function deliver(item: ClaimedItem, isDue: boolean): Promise<void> {
  // sendToChatId sends plain text, so titles need no escaping.
  const lines = [`⏰ ${item.thread_title}: ${item.title}`];
  if (isDue && item.due_at) lines.push(`Due ${item.due_at}`);
  lines.push(`${config.dashboardUrl.replace(/\/+$/, '')}/threads/${item.thread_id}`);

  try {
    const user = await client.execute({
      sql: `SELECT telegram_chat_id FROM users WHERE id = ?`,
      args: [item.user_id],
    });
    const chatId = (user.rows[0]?.telegram_chat_id as string | null | undefined) ?? null;
    if (chatId && telegramNotifier.isConfigured()) {
      await telegramNotifier.sendToChatId(chatId, lines.join('\n\n'));
    }
  } catch (err) {
    console.warn(`[thread-scheduler] telegram for item ${item.id} failed:`, err instanceof Error ? err.message : err);
  }

  try {
    await apnsService.notifyUser(
      item.user_id,
      { title: item.thread_title, body: item.title },
      { threadId: item.thread_id }
    );
  } catch (err) {
    console.warn(`[thread-scheduler] push for item ${item.id} failed:`, err instanceof Error ? err.message : err);
  }
}

/** Run one tick. Exported for the interval and for tests. */
export async function runReminderTick(now: Date = new Date()): Promise<{ delivered: number }> {
  const nowIso = now.toISOString();
  const nudges = await claimNudges(nowIso);
  const dues = await claimDues(nowIso);

  for (const item of nudges) await deliver(item, false);
  for (const item of dues) await deliver(item, true);

  const delivered = nudges.length + dues.length;
  if (delivered) console.log(`[thread-scheduler] delivered ${delivered} reminder(s)`);
  return { delivered };
}

/** Start the per-minute reminder tick and the 15-minute watcher sweep. Call once at server startup. */
export function startThreadScheduler(): void {
  setInterval(() => {
    runReminderTick().catch((err) =>
      console.warn('[thread-scheduler] tick failed:', err instanceof Error ? err.message : err)
    );
  }, TICK_INTERVAL_MS).unref();

  setInterval(() => {
    runWatcherSweep().catch((err) =>
      console.warn('[thread-scheduler] watcher sweep failed:', err instanceof Error ? err.message : err)
    );
  }, WATCHER_SWEEP_INTERVAL_MS).unref();
}
