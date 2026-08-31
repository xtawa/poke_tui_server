import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_BASE_URL: z.string().url(),
  POKE_API_KEY: z.string().min(16),
  MCP_SHARED_SECRET: z.string().min(32),
  DEVICE_ENROLLMENT_SECRET: z.string().min(32),
  DATABASE_PATH: z.string().default('./data/poke.db'),
  LOG_LEVEL: z.string().default('info'),
  MAX_MESSAGE_LENGTH: z.coerce.number().int().min(256).max(65536).default(16384),
  WS_HEARTBEAT_INTERVAL: z.coerce.number().int().min(5000).default(30000),
  POKE_REPLY_TIMEOUT_MS: z.coerce.number().int().min(10000).default(180000),
  POKE_USER_ID_ALLOWLIST: z.string().default(''),
  STORE_MESSAGE_CONTENT: z.string().default('false').transform(v => v === 'true')
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env);
}

export function pokeUserAllowlist(config: Config): Set<string> {
  return new Set(config.POKE_USER_ID_ALLOWLIST.split(',').map(v => v.trim()).filter(Boolean));
}
