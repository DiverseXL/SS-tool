import { existsSync } from 'node:fs';
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  DATABASE_URL: z
    .string()
    .min(1, 'is required')
    // Skip the format check on empty values so a missing variable reports only
    // the clearer "is required" message.
    .refine(
      (value) => value === '' || value.startsWith('postgres://') || value.startsWith('postgresql://'),
      'must be a postgres:// or postgresql:// connection string',
    ),

  // Optional AI extraction provider (OpenAI-compatible). All three connection
  // values must be supplied together; the extraction endpoint reports a clear
  // 503 when they are absent. `.env.example` documents the expected values.
  AI_BASE_URL: z.url('must be a valid absolute URL').optional(),
  AI_API_KEY: z.string().min(1, 'must not be empty').optional(),
  AI_MODEL: z.string().min(1, 'must not be empty').optional(),
  AI_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(30_000),
  AI_MAX_INPUT_TOKENS: z.coerce.number().int().min(256).max(200_000).default(8_000),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(16_000).default(1_500),

  // Single-admin dashboard. All three values are optional at boot so the public
  // site and APIs remain usable before the dashboard is configured; login then
  // returns 503 AUTH_NOT_CONFIGURED instead of accepting a default credential.
  ADMIN_EMAIL: z.email('must be a valid email address').optional(),
  ADMIN_PASSWORD: z.string().min(12, 'must be at least 12 characters').optional(),
  SESSION_SECRET: z
    .string()
    .min(32, 'must be at least 32 characters')
    .optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(8),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

/**
 * Loads `.env` (if present) and validates the environment exactly once.
 * Throws a readable error listing invalid or missing variables without printing
 * their values, so secrets never end up in logs or stack traces.
 */
export function loadEnv(options: { envFile?: string } = {}): Env {
  if (cachedEnv) return cachedEnv;

  const envFile = options.envFile ?? '.env';
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        'Copy .env.example to .env and fill in the required values. ' +
        'Variable values are not printed to avoid leaking secrets.',
    );
  }

  cachedEnv = result.data;
  return cachedEnv;
}
