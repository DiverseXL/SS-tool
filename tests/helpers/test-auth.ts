import type { FastifyInstance } from 'fastify';
import type { AuthConfig } from '../../src/auth/auth-service.js';

/** Explicit test-only administrator configuration; never used by the app. */
export const TEST_AUTH: AuthConfig = {
  email: 'admin@ss-tool.test',
  password: 'test-password-long-enough',
  sessionSecret: 'test-session-secret-with-at-least-32-characters',
  sessionTtlMs: 8 * 60 * 60 * 1000,
};

const cookies = new WeakMap<FastifyInstance, string>();

export async function login(
  app: FastifyInstance,
  credentials: { email: string; password: string } = {
    email: TEST_AUTH.email as string,
    password: TEST_AUTH.password as string,
  },
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: credentials,
  });

  if (response.statusCode !== 200) {
    throw new Error(`Test login failed (${response.statusCode}): ${response.body}`);
  }

  const header = response.headers['set-cookie'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) throw new Error('Test login did not return a session cookie.');

  const cookie = raw.split(';')[0];
  if (!cookie) throw new Error('Test login returned an empty session cookie.');

  cookies.set(app, cookie);
  return cookie;
}

export function authCookie(app: FastifyInstance): string {
  const cookie = cookies.get(app);
  if (!cookie) throw new Error('The app has no test session; call login(app) first.');
  return cookie;
}

export function authHeaders(app: FastifyInstance): Record<string, string> {
  return { cookie: authCookie(app) };
}
