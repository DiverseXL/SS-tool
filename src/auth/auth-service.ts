import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export const SESSION_COOKIE_NAME = 'ss_session';
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const PASSWORD_SALT = 'ss-tool-admin-password-v1';
const MIN_SESSION_SECRET_LENGTH = 32;

export interface AuthConfig {
  email?: string | undefined;
  password?: string | undefined;
  sessionSecret?: string | undefined;
  sessionTtlMs?: number | undefined;
  secureCookies?: boolean | undefined;
}

export interface AdminSession {
  id: string;
  email: string;
  expiresAt: Date;
}

export interface LoginRateLimit {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface AuthService {
  /** Random fallback used only to sign cookies when auth is unconfigured. */
  readonly cookieSecret: string;
  readonly sessionTtlSeconds: number;
  readonly secureCookies: boolean;
  isConfigured(): boolean;
  configurationError(): string | null;
  authenticateRequest(request: FastifyRequest): AdminSession | null;
  login(email: string, password: string): Promise<AdminSession | null>;
  createSession(email: string): AdminSession;
  getSession(id: string): AdminSession | undefined;
  destroySession(id: string): void;
  checkRateLimit(ip: string): LoginRateLimit;
  recordFailure(ip: string): void;
  clearFailures(ip: string): void;
}

interface AttemptWindow {
  count: number;
  resetAt: number;
}

function derivePassword(password: string): Buffer {
  return scryptSync(password, PASSWORD_SALT, 32);
}

function digestEmail(email: string): Buffer {
  return createHash('sha256').update(email.trim().toLowerCase()).digest();
}

/**
 * Shared constant-time credential check used by both the Fastify admin service
 * and the Cloudflare Pages adapter. Credentials still come only from server
 * configuration; this helper never stores or returns them.
 */
export function verifyAdminCredentials(
  candidateEmail: string,
  candidatePassword: string,
  configuredEmail: string | undefined,
  configuredPassword: string | undefined,
): boolean {
  if (!configuredEmail || !configuredPassword) return false;

  const emailMatches = timingSafeEqual(
    digestEmail(candidateEmail),
    digestEmail(configuredEmail),
  );
  const passwordMatches = timingSafeEqual(
    derivePassword(candidatePassword),
    derivePassword(configuredPassword),
  );

  return emailMatches && passwordMatches;
}

/**
 * Single-administrator authentication for the hackathon build.
 *
 * Credentials come from explicit configuration, never from this module. The
 * session lives in an in-memory map and the browser receives only a random,
 * signed session identifier: no email, role or expiry data is trusted from the
 * client. Restarting the process intentionally invalidates every session.
 */
export function createAuthService(config: AuthConfig = {}): AuthService {
  const email = config.email?.trim() ?? '';
  const password = config.password ?? '';
  const secret = config.sessionSecret ?? '';
  const ttlMs = config.sessionTtlMs ?? SESSION_TTL_MS;

  const configured =
    email.length > 0 &&
    password.length > 0 &&
    secret.length >= MIN_SESSION_SECRET_LENGTH &&
    ttlMs > 0;

  const cookieSecret = configured ? secret : randomBytes(32).toString('base64url');

  const sessions = new Map<string, AdminSession>();
  const attempts = new Map<string, AttemptWindow>();

  function pruneSessions(now = Date.now()): void {
    for (const [id, session] of sessions) {
      if (session.expiresAt.getTime() <= now) sessions.delete(id);
    }
  }

  return {
    cookieSecret,
    sessionTtlSeconds: Math.max(1, Math.floor(ttlMs / 1000)),
    secureCookies: config.secureCookies ?? false,

    isConfigured() {
      return configured;
    },

    configurationError() {
      if (configured) return null;
      return 'Dashboard authentication is not configured. Set ADMIN_EMAIL, ADMIN_PASSWORD and SESSION_SECRET (minimum 32 characters).';
    },

    authenticateRequest(request) {
      const raw = request.cookies[SESSION_COOKIE_NAME];
      if (!raw) return null;

      const unsigned = request.unsignCookie(raw);
      if (!unsigned.valid || !unsigned.value) return null;

      return this.getSession(unsigned.value) ?? null;
    },

    async login(candidateEmail, candidatePassword) {
      if (!configured) return null;

      // Hash both values every time so a wrong email takes the same work as a
      // wrong password. The final comparisons are constant-time.
      if (!verifyAdminCredentials(candidateEmail, candidatePassword, email, password)) {
        return null;
      }

      return this.createSession(email);
    },

    createSession(sessionEmail) {
      pruneSessions();
      const session: AdminSession = {
        id: randomBytes(32).toString('base64url'),
        email: sessionEmail,
        expiresAt: new Date(Date.now() + ttlMs),
      };
      sessions.set(session.id, session);
      return session;
    },

    getSession(id) {
      pruneSessions();
      return sessions.get(id);
    },

    destroySession(id) {
      sessions.delete(id);
    },

    checkRateLimit(ip) {
      const now = Date.now();
      const window = attempts.get(ip);

      if (!window || window.resetAt <= now) {
        if (window) attempts.delete(ip);
        return { allowed: true, retryAfterSeconds: 0 };
      }

      if (window.count < MAX_LOGIN_ATTEMPTS) {
        return { allowed: true, retryAfterSeconds: 0 };
      }

      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
      };
    },

    recordFailure(ip) {
      const now = Date.now();
      const existing = attempts.get(ip);

      if (!existing || existing.resetAt <= now) {
        attempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
        return;
      }

      existing.count += 1;
    },

    clearFailures(ip) {
      attempts.delete(ip);
    },
  };
}
