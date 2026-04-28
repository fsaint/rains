import type { Context } from 'grammy';
import type { Applicant } from '../db.js';
import { getApplicant } from '../db.js';
import { HELM } from '../persona.js';

const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes

export async function handleNotifyBot(
  ctx: Context,
  applicant: Applicant
): Promise<'provisioning' | void> {
  await ctx.reply(HELM.notifyBotInstructions);

  const telegramUserId = Number(applicant.telegram_user_id);
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
          await ctx.reply(HELM.notifyBotTimeout);
          resolve('provisioning');
        }
      } catch (err) {
        console.log('[notify-bot] poll error for user', telegramUserId, ':', err instanceof Error ? err.stack : err);
        clearInterval(interval);
        resolve(undefined);
      }
    }, POLL_INTERVAL_MS);
  });
}
