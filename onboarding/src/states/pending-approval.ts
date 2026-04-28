import type { Context } from 'grammy';
import type { Applicant } from '../db.js';
import { HELM } from '../persona.js';

export async function handlePendingApproval(ctx: Context, _applicant: Applicant): Promise<void> {
  await ctx.reply(HELM.waitingOnClearance);
}
