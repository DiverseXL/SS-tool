export interface HyperdriveBinding {
  connectionString: string;
}

/**
 * Bindings available to Pages Functions. Production database credentials come
 * from Hyperdrive; local `wrangler pages dev` can use DATABASE_URL in
 * `.dev.vars`. SERV and admin secrets are Cloudflare environment variables,
 * never frontend build variables.
 */
export interface PagesEnv {
  HYPERDRIVE?: HyperdriveBinding;
  DATABASE_URL?: string;
  NODE_ENV?: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  SESSION_TTL_HOURS?: string;
  SERV_API_KEY?: string;
  SERV_MODEL?: string;
  SERV_BASE_URL?: string;
  SERV_TIMEOUT_MS?: string;
  SERV_MAX_INPUT_TOKENS?: string;
  SERV_MAX_OUTPUT_TOKENS?: string;
  AI_BASE_URL?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
  AI_TIMEOUT_MS?: string;
  AI_MAX_INPUT_TOKENS?: string;
  AI_MAX_OUTPUT_TOKENS?: string;
  [key: string]: unknown;
}

export interface PagesContext {
  request: Request;
  env: PagesEnv;
  params: Record<string, string | string[]>;
  next(): Promise<Response>;
  waitUntil(promise: Promise<unknown>): void;
}
