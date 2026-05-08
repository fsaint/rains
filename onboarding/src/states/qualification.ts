import type { Context, Bot } from 'grammy';
import type { Applicant } from '../db.js';
import { updateApplicant } from '../db.js';
import { HELM } from '../persona.js';
import { config } from '../config.js';

let _bot: Bot | null = null;

export function setBot(bot: Bot): void {
  _bot = bot;
}

export async function handleQualification(
  ctx: Context,
  applicant: Applicant
): Promise<'pending_approval' | void> {
  const text = ctx.message?.text?.trim();

  if (!text) return;

  // If no use_case yet, treat any message as the use-case answer.
  // The greeting is sent on /start (handled separately), so here we
  // always try to capture the user's answer.
  if (!applicant.use_case) {
    // /start in this state just shows the greeting
    if (text === '/start') {
      await ctx.reply(HELM.greeting);
      return;
    }

    // Record their use case and ask for Gmail
    await updateApplicant(ctx.from!.id, { use_case: text });
    await ctx.reply(HELM.askGmail);
    return;
  }

  if (!applicant.gmail_address) {
    // Validate it looks like an email
    if (!text.includes('@') || !text.includes('.')) {
      await ctx.reply("That doesn't look like a valid email. Drop your Gmail address here.");
      return;
    }

    await updateApplicant(ctx.from!.id, { gmail_address: text });

    // Notify admin (fire-and-forget — don't block user flow on failure)
    if (_bot) {
      const username = applicant.username ? `@${applicant.username}` : `User ${ctx.from!.id}`;
      _bot.api.sendMessage(
        config.adminChatId ?? config.adminTelegramId,
        `New applicant: ${username}\nUse case: "${applicant.use_case}"\nGmail: ${text}\n/approve_${ctx.from!.id}  /reject_${ctx.from!.id}`
      ).catch((err: unknown) => console.error('[qualification] admin notification failed:', err));
    }

    await ctx.reply(HELM.pendingApproval);
    return 'pending_approval';
  }

  // Already answered — they're waiting for admin approval
  await ctx.reply(HELM.waitingOnClearance);
}
