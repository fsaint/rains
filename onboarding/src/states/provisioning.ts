import type { Context } from 'grammy';
import type { Applicant } from '../db.js';
import { updateApplicant } from '../db.js';
import { HELM } from '../persona.js';
import { createAndDeploy, getInitialPromptTemplate } from '../api-client.js';
import { config } from '../config.js';

interface ApiError extends Error {
  code?: string;
}

export async function handleProvisioning(
  ctx: Context,
  applicant: Applicant
): Promise<'validating' | 'botfather' | void> {
  await ctx.reply(HELM.provisioning);

  const username = applicant.username ?? `user${applicant.telegram_user_id}`;
  const telegramUserId = Number(applicant.telegram_user_id);

  try {
    const initialPrompt = await getInitialPromptTemplate('email-and-calendar');
    const response = await createAndDeploy({
      name: `${username}'s Agent`,
      ...(config.sharedBotEnabled ? {} : { telegramToken: applicant.bot_token! }),
      telegramUserId: String(telegramUserId),
      onboardingTelegramUserId: telegramUserId,
      minimaxApiKey: applicant.minimax_key ?? undefined,
      initialPrompt,
    });

    await updateApplicant(telegramUserId, {
      agent_id: response.data.id,
      deployment_id: response.data.deployment.deploymentId,
      bot_username: response.data.botUsername ?? null,
    });

    return 'validating';
  } catch (err: unknown) {
    const apiErr = err as ApiError;
    if (apiErr.code === 'SHARED_BOT_LIMIT_REACHED') {
      // User already has a shared-bot agent — they need their own bot token
      await ctx.reply(HELM.botfatherSecondAgent);
      return 'botfather';
    }
    console.log('[provisioning] failed:', err instanceof Error ? err.stack : err);
    await ctx.reply(HELM.error);
  }
}
