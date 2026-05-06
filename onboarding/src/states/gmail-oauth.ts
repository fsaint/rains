import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { Applicant } from '../db.js';
import { HELM } from '../persona.js';
import { generateOAuthLink } from '../api-client.js';

interface ApiError extends Error {
  status?: number;
}

export async function handleGmailOauth(ctx: Context, applicant: Applicant): Promise<'minimax_key' | void> {
  try {
    const { url } = await generateOAuthLink(Number(applicant.telegram_user_id));
    const keyboard = new InlineKeyboard().url('Connect Gmail →', url);
    await ctx.reply(HELM.gmailOauth, { reply_markup: keyboard });
  } catch (err: unknown) {
    const apiErr = err as ApiError;
    if (apiErr.status === 409) {
      // Already linked — advance state machine
      await ctx.reply('Your Gmail is already connected. Continuing...');
      return 'minimax_key';
    } else {
      console.log('[gmail-oauth] error generating OAuth link:', err instanceof Error ? err.stack : err);
      await ctx.reply(HELM.error);
    }
  }
}
