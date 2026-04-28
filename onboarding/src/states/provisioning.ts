import type { Context } from 'grammy';
import type { Applicant } from '../db.js';
import { updateApplicant } from '../db.js';
import { HELM } from '../persona.js';
import { createAndDeploy } from '../api-client.js';

export async function handleProvisioning(
  ctx: Context,
  applicant: Applicant
): Promise<'validating' | void> {
  await ctx.reply(HELM.provisioning);

  const username = applicant.username ?? `user${applicant.telegram_user_id}`;
  const telegramUserId = Number(applicant.telegram_user_id);

  try {
    const response = await createAndDeploy({
      name: `${username}'s Agent`,
      telegramToken: applicant.bot_token!,
      telegramUserId: String(telegramUserId),
      minimaxKey: applicant.minimax_key!,
      onboardingTelegramUserId: telegramUserId,
    });

    await updateApplicant(telegramUserId, {
      agent_id: response.data.id,
      deployment_id: response.data.deployment.deploymentId,
    });

    return 'validating';
  } catch (err: unknown) {
    console.log('[provisioning] failed:', err instanceof Error ? err.stack : err);
    await ctx.reply(HELM.error);
  }
}
