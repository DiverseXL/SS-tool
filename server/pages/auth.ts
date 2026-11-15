import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  verifyAdminCredentials,
} from '../../src/auth/auth-service.js';
import type { AdminSession } from '../../src/auth/auth-service.js';
import type { Database } from '../../src/db/client.js';
import type { PagesEnv } from './env.js';

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const MIN_SESSION_SECRET_LENGTH = 32;

export interface PagesAuthService {
  isConfigured(): boolean;
  configurationError(): string | null;
  secureCookies: boolean;
  sessionTtlSeconds: number;
  authenticate(request: Request): Promise<AdminSession | null>;
  login(email: string, password: string, ip: string): Promise<LoginResult>;
  logout(request: Request): Promise<void>;
  sessionCookie(session: AdminSession): string;
  clearCookie(): string;
}

export type LoginResult =
  | { ok: true; session: AdminSession; cookie: string }
  | { ok: false; status: 401 | 429 | 503; code: string; message: string; retryAfterSeconds?: number };

function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get('cookie') ?? '';
  const cookies: Record<string, string> = {};

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }

  return cookies;
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function signedValue(sessionId: string, secret: string): string {
  return `${sessionId}.${sign(sessionId, secret)}`;
}

function readSignedSession(raw: string, secret: string): string | null {
  const index = raw.lastIndexOf('.');
  if (index <= 0) return null;

  const sessionId = raw.slice(0, index);
  const signature = raw.slice(index + 1);
  const expected = sign(sessionId, secret);

  try {
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
    return sessionId;
  } catch {
    return null;
  }
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/**
 * Persistent admin authentication for Cloudflare Pages Functions. It reuses
 * the same scrypt credential verification as the Fastify service while
 * replacing the in-memory session map with PostgreSQL rows so every isolate
 * sees the same session and logout state.
 */
export function createPagesAuthService(database: Database, env: PagesEnv): PagesAuthService {
  const email = env.ADMIN_EMAIL?.trim() ?? '';
  const password = env.ADMIN_PASSWORD ?? '';
  const secret = env.SESSION_SECRET ?? '';
  const configured =
    email.length > 0 &&
    password.length > 0 &&
    secret.length >= MIN_SESSION_SECRET_LENGTH;
  const ttlHours = Number(env.SESSION_TTL_HOURS ?? '8');
  const ttlMs =
    Number.isFinite(ttlHours) && ttlHours >= 1 && ttlHours <= 168
      ? ttlHours * 60 * 60 * 1000
      : SESSION_TTL_MS;
  const secureCookies =
    env.NODE_ENV === 'production' || (env.NODE_ENV !== 'development' && secret.length > 0);

  function cookieOptions(): string {
    return [
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      secureCookies ? 'Secure' : '',
    ].filter(Boolean).join('; ');
  }

  return {
    secureCookies,
    sessionTtlSeconds: Math.max(1, Math.floor(ttlMs / 1000)),

    isConfigured() {
      return configured;
    },

    configurationError() {
      if (configured) return null;
      return 'Dashboard authentication is not configured. Set ADMIN_EMAIL, ADMIN_PASSWORD and SESSION_SECRET (minimum 32 characters).';
    },

    async authenticate(request) {
      if (!configured) return null;
      const raw = parseCookies(request)[SESSION_COOKIE_NAME];
      if (!raw) return null;

      const sessionId = readSignedSession(raw, secret);
      if (!sessionId) return null;

      const [row] = await database.client`
        select id, email, expires_at
        from admin_sessions
        where id = ${sessionId} and expires_at > now()
        limit 1
      `;

      if (!row?.id) return null;
      return {
        id: String(row.id),
        email: String(row.email),
        expiresAt: toDate(row.expires_at),
      };
    },

    async login(candidateEmail, candidatePassword, ip) {
      if (!configured) {
        return {
          ok: false,
          status: 503,
          code: 'AUTH_NOT_CONFIGURED',
          message: 'Dashboard authentication is not configured.',
        };
      }

      const now = new Date();
      const [attempt] = await database.client`
        select attempt_count, reset_at from login_attempts where ip = ${ip} limit 1
      `;
      const resetAt = attempt ? toDate(attempt.reset_at) : null;
      const activeAttempts =
        resetAt && resetAt.getTime() > now.getTime() ? Number(attempt?.attempt_count ?? 0) : 0;

      if (activeAttempts >= MAX_LOGIN_ATTEMPTS && resetAt) {
        return {
          ok: false,
          status: 429,
          code: 'LOGIN_RATE_LIMITED',
          message: 'Too many sign-in attempts. Wait a few minutes and try again.',
          retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000)),
        };
      }

      if (!verifyAdminCredentials(candidateEmail, candidatePassword, email, password)) {
        // Pass timestamps as ISO strings: workerd's Date objects are not
        // recognised by postgres.js' cross-realm `instanceof Date` check.
        const nextReset = new Date(now.getTime() + LOGIN_WINDOW_MS).toISOString();
        await database.client`
          insert into login_attempts (ip, attempt_count, reset_at)
          values (${ip}, 1, ${nextReset}::timestamptz)
          on conflict (ip) do update
          set attempt_count = case
                when login_attempts.reset_at <= now() then 1
                else login_attempts.attempt_count + 1
              end,
              reset_at = case
                when login_attempts.reset_at <= now() then excluded.reset_at
                else login_attempts.reset_at
              end
        `;

        return {
          ok: false,
          status: 401,
          code: 'INVALID_CREDENTIALS',
          message: 'Email or password is incorrect.',
        };
      }

      await database.client`delete from login_attempts where ip = ${ip}`;

      const session: AdminSession = {
        id: randomBytes(32).toString('base64url'),
        email,
        expiresAt: new Date(now.getTime() + ttlMs),
      };

      await database.client`
        insert into admin_sessions (id, email, expires_at)
        values (${session.id}, ${session.email}, ${session.expiresAt.toISOString()}::timestamptz)
      `;

      // Opportunistic cleanup keeps expired rows bounded without a cron job.
      await database.client`delete from admin_sessions where expires_at <= now()`;

      return {
        ok: true,
        session,
        cookie: this.sessionCookie(session),
      };
    },

    async logout(request) {
      if (!configured) return;
      const raw = parseCookies(request)[SESSION_COOKIE_NAME];
      if (!raw) return;
      const sessionId = readSignedSession(raw, secret);
      if (!sessionId) return;
      await database.client`delete from admin_sessions where id = ${sessionId}`;
    },

    sessionCookie(session) {
      const maxAge = Math.max(
        1,
        Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
      );
      return `${SESSION_COOKIE_NAME}=${encodeURIComponent(signedValue(session.id, secret))}; ${cookieOptions()}; Max-Age=${maxAge}; Expires=${session.expiresAt.toUTCString()}`;
    },

    clearCookie() {
      return `${SESSION_COOKIE_NAME}=; ${cookieOptions()}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    },
  };
}

export function requestIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

export function isPrivateApiPath(pathname: string): boolean {
  const prefixes = [
    '/api/v1/manufacturers',
    '/api/v1/products',
    '/api/v1/catalogue',
    '/api/v1/evidence',
    '/api/v1/dashboard',
    '/api/v1/auth/session',
  ];
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
