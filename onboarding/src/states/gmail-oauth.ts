import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { Applicant } from '../db.js';
import { HELM } from '../persona.js';
import { generateOAuthLink } from '../api-client.js';

interface ApiError extends Error {
  status?: number;
}

export async function handleGmailOauth(ctx: Context, applicant: Applicant): Promise<void> {
  try {
    const { url } = await generateOAuthLink(Number(applicant.telegram_user_id));
    const keyboard = new InlineKeyboard().url('Connect Gmail →', url);
    await ctx.reply(HELM.gmailOauth, { reply_markup: keyboard });
  } catch (err: unknown) {
    const apiErr = err as ApiError;
    if (apiErr.status === 409) {
      // Already linked — advance handled by webhook
      await ctx.reply('Your Gmail is already connected. Continuing...');
    } else {
      console.log('[gmail-oauth] error generating OAuth link:', err instanceof Error ? err.stack : err);
      await ctx.reply(HELM.error);
    }
  }
}
