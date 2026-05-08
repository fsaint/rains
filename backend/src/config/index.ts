import { config as dotenvConfig } from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// Load .env before reading process.env
const dotResult = dotenvConfig({ path: resolve(process.cwd(), '.env') });
if (dotResult.error) {
  dotenvConfig({ path: resolve(process.cwd(), '../.env') });
}

// Load environment-specific YAML config (non-secrets).
// env vars always win — YAML provides defaults only.
function loadYamlConfig(env: string): Record<string, unknown> {
  const candidates = [
    resolve(process.cwd(), `config/${env}.yaml`),
    resolve(process.cwd(), `../config/${env}.yaml`),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return parseYaml(readFileSync(p, 'utf8')) as Record<string, unknown>;
    }
  }
  return {};
}

type YamlConfig = {
  server?: { port?: number; host?: string; log_level?: string };
  urls?: { dashboard_url?: string; public_url?: string };
  oauth?: {
    google_redirect_uri?: string;
    google_login_redirect_uri?: string;
    microsoft_redirect_uri?: string;
    microsoft_tenant_id?: string;
  };
  fly?: { org?: string; openclaw_app?: string; openclaw_image?: string; hermes_image?: string };
  browser?: { max_instances?: number; idle_timeout_ms?: number };
  onboarding?: { bot_webhook_url?: string };
};

const env = process.env.NODE_ENV ?? 'development';
const yaml = loadYamlConfig(env) as YamlConfig;

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

  // Public URL (used in MCP config for deployed agents)
  publicUrl: z.string().optional(),

  // Google OAuth (for Gmail, Drive, Calendar)
  googleClientId: z.string().optional(),
  googleClientSecret: z.string().optional(),
  googleRedirectUri: z.string().default('https://reins.btv.pw/api/oauth/google/callback'),
  googleLoginRedirectUri: z.string().default('https://reins.btv.pw/api/auth/google/callback'),

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

  // Fly.io agent provisioning
  flyOrg: z.string().optional(),
  openclawApp: z.string().default('agentx-openclaw'),
  openclawImage: z.string().optional(),
  hermesImage: z.string().optional(),

  // Telegram notification bot
  reisTelegramBotToken: z.string().optional(),
  reisTelegramWebhookSecret: z.string().optional(),

  // Shared Telegram bot (pilot mode — routes messages by sender user ID)
  sharedBotToken: z.string().optional(),
  sharedBotWebhookSecret: z.string().optional(),

  // Onboarding bot
  onboardingApiKey: z.string().optional(),
  onboardingBotWebhookUrl: z.string().optional(),
  onboardingBotWebhookSecret: z.string().optional(),

  // PostHog analytics
  posthogApiKey: z.string().optional(),
  posthogHost: z.string().default('https://us.i.posthog.com'),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  // env vars win; YAML provides defaults for non-secrets
  const raw = {
    port: process.env.REINS_PORT ?? yaml.server?.port,
    host: process.env.REINS_HOST ?? yaml.server?.host,
    databaseUrl: process.env.DATABASE_URL,
    encryptionKey: process.env.REINS_ENCRYPTION_KEY,
    logLevel: process.env.REINS_LOG_LEVEL ?? yaml.server?.log_level,
    nodeEnv: process.env.NODE_ENV,
    // Dashboard / public URL
    dashboardUrl: process.env.REINS_DASHBOARD_URL ?? yaml.urls?.dashboard_url,
    publicUrl: process.env.REINS_PUBLIC_URL ?? yaml.urls?.public_url,
    // Google OAuth
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: process.env.GOOGLE_REDIRECT_URI ?? yaml.oauth?.google_redirect_uri,
    googleLoginRedirectUri: process.env.GOOGLE_LOGIN_REDIRECT_URI ?? yaml.oauth?.google_login_redirect_uri,
    // Microsoft OAuth
    microsoftClientId: process.env.MICROSOFT_CLIENT_ID,
    microsoftClientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    microsoftTenantId: process.env.MICROSOFT_TENANT_ID ?? yaml.oauth?.microsoft_tenant_id,
    microsoftRedirectUri: process.env.MICROSOFT_REDIRECT_URI ?? yaml.oauth?.microsoft_redirect_uri,
    // Auth
    adminEmail: process.env.REINS_ADMIN_EMAIL,
    adminPassword: process.env.REINS_ADMIN_PASSWORD,
    sessionSecret: process.env.REINS_SESSION_SECRET,
    // Brave Search
    braveApiKey: process.env.BRAVE_API_KEY,
    // Browser
    browserMaxInstances: process.env.BROWSER_MAX_INSTANCES ?? yaml.browser?.max_instances,
    browserIdleTimeout: process.env.BROWSER_IDLE_TIMEOUT ?? yaml.browser?.idle_timeout_ms,
    // Mailgun
    mailgunApiKey: process.env.MAILGUN_API_KEY,
    mailgunDomain: process.env.MAILGUN_DOMAIN,
    mailgunFrom: process.env.MAILGUN_FROM,
    // Fly.io
    flyOrg: process.env.FLY_ORG ?? yaml.fly?.org,
    openclawApp: process.env.OPENCLAW_APP ?? yaml.fly?.openclaw_app,
    openclawImage: process.env.OPENCLAW_IMAGE || yaml.fly?.openclaw_image || undefined,
    hermesImage: process.env.HERMES_IMAGE || yaml.fly?.hermes_image || undefined,
    // Telegram
    reisTelegramBotToken: process.env.REINS_TELEGRAM_BOT_TOKEN,
    reisTelegramWebhookSecret: process.env.REINS_TELEGRAM_WEBHOOK_SECRET,
    // Shared bot
    sharedBotToken: process.env.SHARED_BOT_TOKEN,
    sharedBotWebhookSecret: process.env.SHARED_BOT_WEBHOOK_SECRET,
    // Onboarding bot
    onboardingApiKey: process.env.ONBOARDING_API_KEY,
    onboardingBotWebhookUrl: process.env.ONBOARDING_BOT_WEBHOOK_URL ?? yaml.onboarding?.bot_webhook_url,
    onboardingBotWebhookSecret: process.env.ONBOARDING_BOT_WEBHOOK_SECRET,
    // PostHog
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
