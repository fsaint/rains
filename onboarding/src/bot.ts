import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { handleMessage, registerHandler } from './state-machine.js';
import { updateApplicant, getApplicant, sql } from './db.js';
import { HELM } from './persona.js';
import { generateOAuthLink } from './api-client.js';

// State handlers
import { handleQualification, setBot } from './states/qualification.js';
import { handlePendingApproval } from './states/pending-approval.js';
import { handleGmailOauth } from './states/gmail-oauth.js';
import { handleMinimaxKey } from './states/minimax-key.js';
import { handleBotfather } from './states/botfather.js';
import { handleNotifyBot } from './states/notify-bot.js';
import { handleProvisioning } from './states/provisioning.js';
import { handleValidating } from './states/validating.js';
import { handlePasswordSetup } from './states/password-setup.js';
import { handleDone } from './states/done.js';

export function createBot(): Bot {
  const bot = new Bot(config.botToken);

  // Give the qualification handler a bot reference for admin notifications
  setBot(bot);

  // Register all state handlers
  registerHandler('qualification', handleQualification);
  registerHandler('pending_approval', handlePendingApproval);
  registerHandler('gmail_oauth', handleGmailOauth);
  registerHandler('minimax_key', handleMinimaxKey);
  registerHandler('botfather', handleBotfather);
  registerHandler('notify_bot', handleNotifyBot);
  registerHandler('provisioning', handleProvisioning);
  registerHandler('validating', handleValidating);
  registerHandler('password_setup', handlePasswordSetup);
  registerHandler('done', handleDone);

  // Single handler for all text messages
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;

    // Admin commands
    if (ctx.from?.id === config.adminTelegramId) {
      const approveMatch = /^\/approve_(\d+)$/.exec(text);
      const rejectMatch = /^\/reject_(\d+)$/.exec(text);
      const resetMatch = /^\/reset_(\d+)$/.exec(text);

      if (approveMatch) {
        const targetId = parseInt(approveMatch[1], 10);
        const applicant = await getApplicant(targetId);
        if (!applicant) {
          await ctx.reply(`No applicant found with ID ${targetId}`);
          return;
        }
        await updateApplicant(targetId, { state: 'gmail_oauth' });
        await bot.api.sendMessage(targetId, HELM.approved);
        try {
          const { url } = await generateOAuthLink(targetId);
          const keyboard = new InlineKeyboard().url('Connect Gmail →', url);
          await bot.api.sendMessage(targetId, HELM.gmailOauth, { reply_markup: keyboard });
        } catch (err) {
          console.log('[approve] failed to send Gmail OAuth link:', err instanceof Error ? err.stack : err);
        }
        await ctx.reply(`Approved ${targetId}`);
        return;
      }

      if (rejectMatch) {
        const targetId = parseInt(rejectMatch[1], 10);
        const applicant = await getApplicant(targetId);
        if (!applicant) {
          await ctx.reply(`No applicant found with ID ${targetId}`);
          return;
        }
        await updateApplicant(targetId, { state: 'rejected', rejected_at: new Date() });
        await bot.api.sendMessage(targetId, HELM.rejected);
        await ctx.reply(`Rejected ${targetId}`);
        return;
      }

      if (resetMatch) {
        const targetId = parseInt(resetMatch[1], 10);
        await sql`DELETE FROM applicants WHERE telegram_user_id = ${targetId}`;
        await ctx.reply(`Reset ${targetId} — clean slate.`);
        return;
      }
    }

    // All users (including admin non-command messages) — route through state machine
    await handleMessage(ctx);
  });

  bot.catch((err) => {
    console.log('[bot] Unhandled error:', err.message, err.error instanceof Error ? err.error.stack : err.error);
  });

  return bot;
}
