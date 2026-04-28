import type { Context } from 'grammy';
import type { Applicant } from '../db.js';
import { updateApplicant } from '../db.js';
import { HELM } from '../persona.js';

// MiniMax API keys are typically long alphanumeric strings (30+ chars)
const MINIMAX_KEY_REGEX = /^[A-Za-z0-9_-]{20,}$/;

async function validateMinimaxKey(key: string): Promise<boolean> {
  try {
    const res = await fetch('https://api.minimax.io/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    // 200 = valid, 404 = endpoint exists (auth passed), anything else is an auth failure
    return res.status === 200 || res.status === 404;
  } catch (err) {
    console.log('[minimax-key] validateMinimaxKey error:', err instanceof Error ? err.message : err);
    return false;
  }
}

export async function handleMinimaxKey(
  ctx: Context,
  applicant: Applicant
): Promise<'botfather' | void> {
  const text = ctx.message?.text?.trim();

  // Empty message or a bot command — show instructions
  if (!text || text.startsWith('/')) {
    await ctx.reply(HELM.minimaxInstructions);
    return;
  }

  // Doesn't look like a key at all — show instructions
  if (!MINIMAX_KEY_REGEX.test(text)) {
    await ctx.reply(HELM.minimaxInstructions);
    return;
  }

  // Looks like a key — validate it against the API
  const valid = await validateMinimaxKey(text);
  if (!valid) {
    await ctx.reply(HELM.minimaxInvalid);
    return;
  }

  await updateApplicant(Number(applicant.telegram_user_id), { minimax_key: text });
  return 'botfather';
}
