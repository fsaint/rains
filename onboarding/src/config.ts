import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// Load the shared project-level YAML config for this environment (non-secrets).
// env vars always override YAML values.
function loadSharedYaml(env: string): { onboarding?: { bot_webhook_url?: string; notify_bot_username?: string } } {
  const candidates = [
    resolve(import.meta.dirname, `../../../config/${env}.yaml`),
    resolve(import.meta.dirname, `../../config/${env}.yaml`),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return parseYaml(readFileSync(p, 'utf8'));
    }
  }
  return {};
}

const sharedYaml = loadSharedYaml(process.env.NODE_ENV ?? 'development');

const ConfigSchema = z.object({
  botToken: z.string().min(1, 'ONBOARDING_BOT_TOKEN is required'),
  databaseUrl: z.string().min(1, 'DATABASE_URL is required'),
  agenthelmApiUrl: z.string().url().default('http://localhost:5001'),
  agenthelmApiKey: z.string().min(1, 'AGENTHELM_API_KEY is required'),
  webhookSecret: z.string().min(1, 'ONBOARDING_BOT_WEBHOOK_SECRET is required'),
  adminTelegramId: z.coerce.number().int().positive(),
  adminChatId: z.coerce.number().int().optional(), // where notifications are sent — defaults to adminTelegramId
  port: z.coerce.number().default(3001),
  webhookUrl: z.string().url().optional(),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  notifyBotUsername: z.string().default('reins_dev_bot'),
  dashboardUrl: z.string().url().default('https://reins-dev.btv.pw'),

  // PostHog analytics
  posthogApiKey: z.string().optional(),
  posthogHost: z.string().default('https://us.i.posthog.com'),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const raw = {
    botToken: process.env.ONBOARDING_BOT_TOKEN,
    databaseUrl: process.env.DATABASE_URL,
    agenthelmApiUrl: process.env.AGENTHELM_API_URL,
    agenthelmApiKey: process.env.AGENTHELM_API_KEY,
    webhookSecret: process.env.ONBOARDING_BOT_WEBHOOK_SECRET,
    adminTelegramId: process.env.ADMIN_TELEGRAM_ID,
    adminChatId: process.env.ADMIN_CHAT_ID,
    port: process.env.PORT,
    webhookUrl: process.env.WEBHOOK_URL,
    nodeEnv: process.env.NODE_ENV,
    notifyBotUsername: process.env.NOTIFY_BOT_USERNAME ?? sharedYaml.onboarding?.notify_bot_username,
    dashboardUrl: process.env.DASHBOARD_URL,
    posthogApiKey: process.env.POSTHOG_API_KEY,
    posthogHost: process.env.POSTHOG_HOST,
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    console.error('Invalid configuration:', result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
