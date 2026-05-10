import { InlineKeyboard } from 'grammy';
import type { Context } from 'grammy';
import type { Applicant } from '../db.js';
import { HELM } from '../persona.js';

export async function handleDone(ctx: Context, applicant: Applicant): Promise<void> {
  const text = ctx.message?.text?.trim() ?? '';
  if (text === '/start') {
    await ctx.reply(HELM.alreadyDone);
    return;
  }

  // Prefer the username stored at provisioning time; fall back to live getMe for custom-bot users.
  let botUsername: string | null = applicant.bot_username ?? null;
  if (!botUsername && applicant.bot_token) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${applicant.bot_token}/getMe`);
      const data = await res.json() as { ok: boolean; result?: { username?: string } };
      if (data.ok && data.result?.username) botUsername = data.result.username;
    } catch {
      // Non-fatal — fall back to text-only message
    }
  }

  if (botUsername) {
    const keyboard = new InlineKeyboard().url('Message your new bot →', `https://t.me/${botUsername}`);
    await ctx.reply(HELM.done, { reply_markup: keyboard });
  } else {
    await ctx.reply(HELM.done);
  }
}
