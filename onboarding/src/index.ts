import { initDb } from './db.js';
import { createBot } from './bot.js';
import { createWebhookServer } from './webhook-server.js';
import { config } from './config.js';

async function main(): Promise<void> {
  // Initialize database schema
  await initDb();
  console.log('[onboarding] DB initialized');

  // Create bot instance (registers all state handlers)
  const bot = createBot();

  // Create webhook server (handles oauth-complete callbacks and Telegram updates in prod)
  const server = createWebhookServer(bot);

  await server.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[onboarding] Webhook server listening on port ${config.port}`);

  if (config.webhookUrl && config.nodeEnv === 'production') {
    // Production: register Telegram webhook
    await bot.api.setWebhook(`${config.webhookUrl}/telegram`);
    console.log(`[onboarding] Telegram webhook set to ${config.webhookUrl}/telegram`);
  } else {
    // Development: use long polling
    console.log('[onboarding] Starting long polling...');
    bot.start();
  }
}

main().catch((err: unknown) => {
  console.error('[onboarding] Fatal error:', err);
  process.exit(1);
});
