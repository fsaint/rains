import type { Context } from 'grammy';
import type { Applicant } from '../db.js';
import { updateApplicant } from '../db.js';
import { HELM } from '../persona.js';

// Telegram bot tokens have the form <bot_id>:<token_string>
const BOT_TOKEN_REGEX = /^\d+:[A-Za-z0-9_-]{35,}$/;

async function validateBotToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json() as { ok: boolean };
    return data.ok === true;
  } catch (err) {
    console.log('[botfather] validateBotToken error:', err instanceof Error ? err.message : err);
    return false;
  }
}

export async function handleBotfather(
  ctx: Context,
  applicant: Applicant
): Promise<'notify_bot' | void> {
  const text = ctx.message?.text?.trim();

  // Empty or a command — show instructions
  if (!text || text.startsWith('/')) {
    await ctx.reply(HELM.botfatherInstructions);
    return;
  }

  // Doesn't match the token format — show instructions
  if (!BOT_TOKEN_REGEX.test(text)) {
    await ctx.reply(HELM.botfatherInstructions);
    return;
  }

  // Looks like a token — validate it against Telegram
  const valid = await validateBotToken(text);
  if (!valid) {
    await ctx.reply(HELM.botfatherInvalid);
    return;
  }

  await updateApplicant(Number(applicant.telegram_user_id), { bot_token: text });
  return 'notify_bot';
}
