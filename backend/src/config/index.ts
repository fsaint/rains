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
  };

  const result = ConfigSchema.safeParse(raw);

  if (!result.success) {
    console.error('Invalid configuration:', result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
