import type { Context } from 'grammy';
import type { Applicant } from '../db.js';
import { HELM } from '../persona.js';

export async function handleDone(ctx: Context, applicant: Applicant): Promise<void> {
  const text = ctx.message?.text?.trim() ?? '';
  if (text === '/start') {
    await ctx.reply(HELM.alreadyDone);
    return;
  }

  let botUsername: string | undefined;
  if (applicant.bot_token) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${applicant.bot_token}/getMe`);
      const data = await res.json() as { ok: boolean; result?: { username?: string } };
      if (data.ok) botUsername = data.result?.username;
    } catch {
      // Non-fatal — fall back to dashboard-only message
    }
  }

  const botLink = botUsername ? `\n\nStart chatting with your agent: t.me/${botUsername}` : '';
  await ctx.reply(`${HELM.done}${botLink}`);
}
