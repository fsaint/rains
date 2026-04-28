import { z } from 'zod';

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
    notifyBotUsername: process.env.NOTIFY_BOT_USERNAME,
    dashboardUrl: process.env.DASHBOARD_URL,
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    console.error('Invalid configuration:', result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
