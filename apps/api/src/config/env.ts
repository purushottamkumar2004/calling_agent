import { z } from 'zod';

const base64Key = (name: string) =>
  z
    .string()
    .min(1, `${name} is required`)
    .refine((v) => Buffer.from(v, 'base64').length === 32, `${name} must be 32 bytes, base64-encoded`);

const secret = (name: string) =>
  z
    .string()
    .min(1, `${name} is required`)
    .refine((v) => Buffer.from(v, 'base64').length >= 32, `${name} must be at least 32 bytes, base64-encoded`);

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(2000),

  REDIS_URL: z.string().url(),

  USER_JWT_SECRET: secret('USER_JWT_SECRET'),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_SEC: z.coerce.number().int().min(3600).default(2_592_000),

  SERVICE_JWT_SECRET: secret('SERVICE_JWT_SECRET'),
  SERVICE_JWT_ALLOWED_ISSUERS: z
    .string()
    .default('voice-gateway,voice-worker,scheduler,postcall-worker')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  SERVICE_JWT_MAX_TTL_SEC: z.coerce.number().int().min(30).max(3600).default(300),

  FIELD_ENCRYPTION_KEY_ID: z
    .string()
    .regex(/^[a-z0-9]{1,16}$/)
    .default('k1'),
  FIELD_ENCRYPTION_KEY: base64Key('FIELD_ENCRYPTION_KEY'),
  PHONE_HASH_KEY: base64Key('PHONE_HASH_KEY'),

  OUTBOX_ENABLED: bool.default('true'),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(500),
});

export type AppConfig = z.infer<typeof envSchema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

/** Validates the environment once at startup; the process refuses to start on bad config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return parsed.data;
}
