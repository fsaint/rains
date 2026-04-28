import type { Context } from 'grammy';
import type { Applicant } from '../db.js';
import { HELM } from '../persona.js';

export async function handleDone(ctx: Context, _applicant: Applicant): Promise<void> {
  const text = ctx.message?.text?.trim() ?? '';
  if (text === '/start') {
    await ctx.reply(HELM.alreadyDone);
    return;
  }
  await ctx.reply(HELM.done);
}
