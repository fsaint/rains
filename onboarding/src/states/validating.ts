import type { Context } from 'grammy';
import type { Applicant } from '../db.js';
import { config } from '../config.js';
import { HELM } from '../persona.js';
import { getDeploymentStatus } from '../api-client.js';

const POLL_INTERVAL_MS = 10_000;
const TIMEOUT_MS = 3 * 60 * 1_000; // 3 minutes

export async function handleValidating(
  ctx: Context,
  applicant: Applicant
): Promise<'password_setup' | void> {
  await ctx.reply(HELM.validating);

  const deadline = Date.now() + TIMEOUT_MS;
  const deploymentId = applicant.deployment_id!;

  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      try {
        const status = await getDeploymentStatus(deploymentId);

        if (status.status === 'running') {
          clearInterval(interval);

          // Send a test message from the user's new bot so they know it's live
          try {
            await fetch(`https://api.telegram.org/bot${applicant.bot_token}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: Number(applicant.telegram_user_id),
                text: "Your agent is online. I'm ready.",
              }),
            });
          } catch {
            // Non-fatal — continue regardless
          }

          resolve('password_setup');
          return;
        }
      } catch (err: unknown) {
        console.error('[validating] status check failed:', err);
      }

      if (Date.now() > deadline) {
        clearInterval(interval);
        await ctx.reply(HELM.validatingTimeout);

        // Alert admin about the timeout
        try {
          const { Bot } = await import('grammy');
          const tmpBot = new Bot(config.botToken);
          await tmpBot.api.sendMessage(
            config.adminTelegramId,
            `Deployment timeout for user ${applicant.telegram_user_id}, deployment ${deploymentId}`
          );
        } catch {
          // Non-fatal
        }

        resolve(undefined);
      }
    }, POLL_INTERVAL_MS);
  });
}
