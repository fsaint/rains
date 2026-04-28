import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { z } from 'zod';

// Load .env before reading process.env
const dotResult = dotenvConfig({ path: resolve(process.cwd(), '.env') });
if (dotResult.error) {
  dotenvConfig({ path: resolve(process.cwd(), '../.env') });
}

const ConfigSchema = z.object({
  // Server
  port: z.coerce.number().default(5001),
  host: z.string().default('0.0.0.0'),

  // Database
  databaseUrl: z.string().default('postgres://localhost:5432/reins'),

  // Encryption
  encryptionKey: z.string().length(64).optional(), // 32-byte hex

  // Logging
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Environment
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),

  // Dashboard URL (for OAuth redirects)
  dashboardUrl: z.string().default('https://reins.btv.pw'),

  // Google OAuth (for Gmail, Drive, Calendar)
  googleClientId: z.string().optional(),
  googleClientSecret: z.string().optional(),
  googleRedirectUri: z.string().default('https://reins.btv.pw/api/oauth/google/callback'),

  // Microsoft OAuth (for Outlook Mail, Outlook Calendar)
  microsoftClientId: z.string().optional(),
  microsoftClientSecret: z.string().optional(),
  microsoftTenantId: z.string().default('common'),
  microsoftRedirectUri: z.string().default('https://reins.btv.pw/api/oauth/microsoft/callback'),

  // Brave Search API
  braveApiKey: z.string().optional(),

  // Auth
  adminEmail: z.string().email().optional(),
  adminPassword: z.string().min(1, 'REINS_ADMIN_PASSWORD is required'),
  sessionSecret: z.string().min(32).default('change-me-to-a-random-32-char-string!!'),

  // Browser server
  browserMaxInstances: z.coerce.number().default(5),
  browserIdleTimeout: z.coerce.number().default(300000), // 5 minutes

  // Mailgun
  mailgunApiKey: z.string().optional(),
  mailgunDomain: z.string().optional(),
  mailgunFrom: z.string().optional(),

  // Onboarding bot
  onboardingApiKey: z.string().optional(),
  onboardingBotWebhookUrl: z.string().optional(),
  onboardingBotWebhookSecret: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const raw = {
    port: process.env.REINS_PORT,
    host: process.env.REINS_HOST,
    databaseUrl: process.env.DATABASE_URL,
    encryptionKey: process.env.REINS_ENCRYPTION_KEY,
    logLevel: process.env.REINS_LOG_LEVEL,
    nodeEnv: process.env.NODE_ENV,
    // Dashboard
    dashboardUrl: process.env.REINS_DASHBOARD_URL,
    // Google OAuth
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: process.env.GOOGLE_REDIRECT_URI,
    // Microsoft OAuth
    microsoftClientId: process.env.MICROSOFT_CLIENT_ID,
    microsoftClientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    microsoftTenantId: process.env.MICROSOFT_TENANT_ID,
    microsoftRedirectUri: process.env.MICROSOFT_REDIRECT_URI,
    // Auth
    adminEmail: process.env.REINS_ADMIN_EMAIL,
    adminPassword: process.env.REINS_ADMIN_PASSWORD,
    sessionSecret: process.env.REINS_SESSION_SECRET,
    // Brave Search
    braveApiKey: process.env.BRAVE_API_KEY,
    // Browser
    browserMaxInstances: process.env.BROWSER_MAX_INSTANCES,
    browserIdleTimeout: process.env.BROWSER_IDLE_TIMEOUT,
    // Mailgun
    mailgunApiKey: process.env.MAILGUN_API_KEY,
    mailgunDomain: process.env.MAILGUN_DOMAIN,
    mailgunFrom: process.env.MAILGUN_FROM,
    // Onboarding bot
    onboardingApiKey: process.env.ONBOARDING_API_KEY,
    onboardingBotWebhookUrl: process.env.ONBOARDING_BOT_WEBHOOK_URL,
    onboardingBotWebhookSecret: process.env.ONBOARDING_BOT_WEBHOOK_SECRET,
  };

  const result = ConfigSchema.safeParse(raw);

  if (!result.success) {
    console.error('Invalid configuration:', result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
