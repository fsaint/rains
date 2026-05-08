import type { Context } from 'grammy';
import type { Applicant } from '../db.js';
import { getApplicant } from '../db.js';
import { HELM } from '../persona.js';

const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes

/**
 * Poll until the applicant's notify_chat_id is set (i.e. they messaged the notify bot).
 * Resolves 'provisioning' when found or on timeout.
 * Exported so webhook-server can start the poll after OAuth without re-sending instructions.
 */
export async function pollForNotifyChatId(
  telegramUserId: number,
  onTimeout: () => Promise<unknown>,
): Promise<'provisioning'> {
  const deadline = Date.now() + TIMEOUT_MS;

  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      try {
        const current = await getApplicant(telegramUserId);

        if (current?.notify_chat_id) {
          clearInterval(interval);
          resolve('provisioning');
          return;
        }

        if (Date.now() > deadline) {
          clearInterval(interval);
          await onTimeout();
          resolve('provisioning');
        }
      } catch (err) {
        console.log('[notify-bot] poll error for user', telegramUserId, ':', err instanceof Error ? err.stack : err);
        clearInterval(interval);
        resolve('provisioning');
      }
    }, POLL_INTERVAL_MS);
  });
}

export async function handleNotifyBot(
  ctx: Context,
  applicant: Applicant
): Promise<'provisioning' | void> {
  await ctx.reply(HELM.notifyBotInstructions);
  return pollForNotifyChatId(
    Number(applicant.telegram_user_id),
    () => ctx.reply(HELM.notifyBotTimeout),
  );
}
