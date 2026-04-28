import Fastify from 'fastify';
import type { Bot } from 'grammy';
import { config } from './config.js';
import { getApplicant, updateApplicant } from './db.js';

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
      await updateApplicant(body.telegramUserId, { state: 'minimax_key' });
      await bot.api.sendMessage(body.telegramUserId, 'Gmail connected.');
      await bot.api.sendMessage(
        body.telegramUserId,
        'Head to platform.minimax.io — create an account and grab your API key. Paste it here when you have it.'
      );
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
