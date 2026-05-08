import Fastify from 'fastify';
import type { Bot, Context } from 'grammy';
import { config } from './config.js';
import { getApplicant, updateApplicant } from './db.js';
import { HELM } from './persona.js';
import { pollForNotifyChatId } from './states/notify-bot.js';
import { handleMessage } from './state-machine.js';

interface OAuthCompleteBody {
  telegramUserId?: number;
  email?: string;
  success?: boolean;
  error?: string;
}

export function createWebhookServer(bot: Bot) {
  const app = Fastify({ logger: false });

  // POST /webhook/oauth-complete — called by AgentHelm when Gmail OAuth completes
  app.post<{ Body: OAuthCompleteBody }>('/webhook/oauth-complete', async (request, reply) => {
    const auth = (request.headers.authorization as string | undefined) ?? '';
    if (auth !== `Bearer ${config.webhookSecret}`) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const body = request.body;

    if (!body.telegramUserId) {
      return reply.code(400).send({ error: 'telegramUserId required' });
    }

    const applicant = await getApplicant(body.telegramUserId);
    if (!applicant) {
      return reply.code(404).send({ error: 'Applicant not found' });
    }

    if (body.success) {
      await updateApplicant(body.telegramUserId, { state: 'notify_bot' });
      await bot.api.sendMessage(body.telegramUserId, HELM.gmailConnected);
      await bot.api.sendMessage(body.telegramUserId, HELM.notifyBotInstructions);

      // Auto-advance: poll for notify_chat_id then run provisioning → validating → done
      // without waiting for the user to send another message to the onboarding bot.
      const userId = body.telegramUserId;
      const sendMsg = (text: string, opts?: object) =>
        bot.api.sendMessage(String(userId), text, opts as never);
      void pollForNotifyChatId(userId, () => sendMsg(HELM.notifyBotTimeout))
        .then(async () => {
          // Guard: only advance if still in notify_bot state (not already moved forward
          // by a concurrent handleNotifyBot call from the user messaging the onboarding bot)
          const current = await getApplicant(userId);
          if (current?.state !== 'notify_bot') return;
          await updateApplicant(userId, { state: 'provisioning' });
          const fakeCtx = {
            from: { id: userId, username: applicant.username ?? undefined },
            message: { text: '' },
            reply: sendMsg,
          } as unknown as Context;
          await handleMessage(fakeCtx);
        })
        .catch(err => console.error('[webhook-server] post-oauth state machine error:', err));
    } else {
      await bot.api.sendMessage(
        body.telegramUserId,
        'Gmail connection failed. Try again when ready.'
      );
    }

    return { ok: true };
  });

  // POST /telegram — Telegram webhook endpoint (production mode)
  app.post('/telegram', async (request, reply) => {
    await bot.handleUpdate(request.body as Parameters<typeof bot.handleUpdate>[0]);
    return reply.send({ ok: true });
  });

  return app;
}
