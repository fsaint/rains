import { z } from 'zod';

const ConfigSchema = z.object({
  // Server
  port: z.coerce.number().default(3000),
  host: z.string().default('0.0.0.0'),

  // Database
  dbPath: z.string().default('./data/reins.db'),

  // Encryption
  encryptionKey: z.string().length(64).optional(), // 32-byte hex

  // Logging
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Environment
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),

  // Google OAuth (for Gmail, Drive, Calendar)
  googleClientId: z.string().optional(),
  googleClientSecret: z.string().optional(),
  googleRedirectUri: z.string().default('http://localhost:3000/api/oauth/google/callback'),

  // Brave Search API
  braveApiKey: z.string().optional(),

  // Browser server
  browserMaxInstances: z.coerce.number().default(5),
  browserIdleTimeout: z.coerce.number().default(300000), // 5 minutes
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const raw = {
    port: process.env.REINS_PORT,
    host: process.env.REINS_HOST,
    dbPath: process.env.REINS_DB_PATH,
    encryptionKey: process.env.REINS_ENCRYPTION_KEY,
    logLevel: process.env.REINS_LOG_LEVEL,
    nodeEnv: process.env.NODE_ENV,
    // Google OAuth
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: process.env.GOOGLE_REDIRECT_URI,
    // Brave Search
    braveApiKey: process.env.BRAVE_API_KEY,
    // Browser
    browserMaxInstances: process.env.BROWSER_MAX_INSTANCES,
    browserIdleTimeout: process.env.BROWSER_IDLE_TIMEOUT,
  };

  const result = ConfigSchema.safeParse(raw);

  if (!result.success) {
    console.error('Invalid configuration:', result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
