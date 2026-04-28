import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { Applicant } from '../db.js';
import { HELM } from '../persona.js';
import { generateSetupLink } from '../api-client.js';

export async function handlePasswordSetup(
  ctx: Context,
  applicant: Applicant
): Promise<'done' | void> {
  try {
    const { url } = await generateSetupLink(Number(applicant.telegram_user_id));
    const keyboard = new InlineKeyboard().url('Set up account →', url);
    await ctx.reply(HELM.passwordSetup, { reply_markup: keyboard });
    return 'done';
  } catch (err: unknown) {
    console.log('[password-setup] failed:', err instanceof Error ? err.stack : err);
    await ctx.reply(HELM.error);
  }
}
