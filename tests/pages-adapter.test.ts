import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleApiRequest } from '../server/api/handler.js';
import { handlePagesMiddleware } from '../server/pages/middleware.js';
import { handleHealth, handleReady } from '../server/pages/health.js';
import type { PagesContext, PagesEnv } from '../server/pages/env.js';
import { loadEnv } from '../src/config/env.js';
import { closeDatabase, createDatabase, type Database } from '../src/db/client.js';

const ADMIN_IP = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
const RATE_LIMIT_IP = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;

let database: Database;
let pagesEnv: PagesEnv;
let adminEmail: string;
let adminPassword: string;

function api(
  path: string,
  init: RequestInit = {},
  cookie?: string,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  return handleApiRequest(
    new Request(`http://localhost${path}`, { ...init, headers }),
    pagesEnv,
  );
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? '';
}

function pageContext(pathname: string, cookie?: string): PagesContext {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  return {
    request: new Request(`http://localhost${pathname}`, { headers }),
    env: pagesEnv,
    params: {},
    next: async () =>
      new Response('<html>static page</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    waitUntil: () => {},
  };
}

async function login(email: string, password: string, ip = ADMIN_IP) {
  return api('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password }),
  });
}

beforeAll(() => {
  const env = loadEnv();
  adminEmail = env.ADMIN_EMAIL ?? '';
  adminPassword = env.ADMIN_PASSWORD ?? '';
  pagesEnv = {
    DATABASE_URL: env.DATABASE_URL,
    NODE_ENV: 'production',
    ADMIN_EMAIL: adminEmail,
    ADMIN_PASSWORD: adminPassword,
    SESSION_SECRET: env.SESSION_SECRET,
    SESSION_TTL_HOURS: '1',
  };
  database = createDatabase(env.DATABASE_URL);
});

afterAll(async () => {
  if (database) {
    await database.client`delete from login_attempts where ip in (${ADMIN_IP}, ${RATE_LIMIT_IP})`;
    await closeDatabase(database);
  }
});

describe('Cloudflare Pages adapter', () => {
  it('serves health and readiness checks', async () => {
    const health = handleHealth();
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: 'ok',
      runtime: 'cloudflare-pages-functions',
    });

    const ready = await handleReady(pagesEnv);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      status: 'ready',
      checks: { database: { status: 'up' } },
    });
  });

  it('keeps public routes available and private routes behind auth', async () => {
    const publicResponse = await api(
      '/api/v1/public/products/00000000-0000-4000-8000-000000000001/support-card',
    );
    expect(publicResponse.status).toBe(404);
    expect(await errorCode(publicResponse)).toBe('PRODUCT_NOT_FOUND');

    const privateResponse = await api('/api/v1/dashboard/summary');
    expect(privateResponse.status).toBe(401);
    expect(await errorCode(privateResponse)).toBe('AUTH_REQUIRED');
  });

  it('persists sessions, protects pages, and invalidates on logout', async () => {
    expect(adminEmail).not.toBe('');
    expect(adminPassword).not.toBe('');
    expect(pagesEnv.SESSION_SECRET?.length ?? 0).toBeGreaterThanOrEqual(32);

    const anonymousPage = await handlePagesMiddleware(pageContext('/dashboard/research'));
    expect(anonymousPage.status).toBe(302);
    expect(anonymousPage.headers.get('location')).toBe(
      'http://localhost/login?next=%2Fdashboard%2Fresearch',
    );

    const response = await login(adminEmail, adminPassword);
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Secure');
    const cookie = setCookie.split(';')[0];
    expect(cookie).toBeTruthy();

    const session = await api('/api/v1/auth/session', {}, cookie);
    expect(session.status).toBe(200);
    expect(((await session.json()) as { data: { email: string } }).data.email).toBe(adminEmail);

    const protectedApi = await api('/api/v1/dashboard/summary', {}, cookie);
    expect(protectedApi.status).toBe(200);

    const protectedPage = await handlePagesMiddleware(pageContext('/dashboard', cookie));
    expect(protectedPage.status).toBe(200);
    expect(protectedPage.headers.get('cache-control')).toBe('no-store');

    const loginPage = await handlePagesMiddleware(pageContext('/login', cookie));
    expect(loginPage.status).toBe(302);
    expect(loginPage.headers.get('location')).toBe('http://localhost/dashboard');

    const logout = await api('/api/v1/auth/logout', { method: 'POST' }, cookie);
    expect(logout.status).toBe(200);

    const afterLogout = await api('/api/v1/auth/session', {}, cookie);
    expect(afterLogout.status).toBe(401);

    const privateAfterLogout = await api('/api/v1/dashboard/summary', {}, cookie);
    expect(privateAfterLogout.status).toBe(401);
  });

  it('rate-limits repeated failed logins by client IP', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await login(adminEmail, 'definitely-not-the-password', RATE_LIMIT_IP);
      expect(response.status).toBe(401);
    }

    const limited = await login(adminEmail, adminPassword, RATE_LIMIT_IP);
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe('LOGIN_RATE_LIMITED');
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });
});
