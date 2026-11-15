import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { closeDatabase, createDatabase, type Database } from '../src/db/client.js';
import {
  evidence,
  evidenceReviews,
  manufacturers,
  productSources,
  products,
  sources,
} from '../src/db/schema.js';
import { createDashboardRepository } from '../src/repositories/dashboard-repository.js';
import { login, TEST_AUTH } from './helpers/test-auth.js';

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PREFIX = `Step9 Dashboard ${RUN_ID}`;

function stubDatabase(): Database {
  return {
    ping: async () => {},
    orm: {} as Database['orm'],
  } as Database;
}

function buildStubApp(auth = TEST_AUTH): FastifyInstance {
  return buildApp({ database: stubDatabase(), logger: false, auth });
}

function setCookieHeader(response: Awaited<ReturnType<FastifyInstance['inject']>>): string {
  const header = response.headers['set-cookie'];
  return Array.isArray(header) ? header.join('\n') : String(header ?? '');
}

function sessionCookie(response: Awaited<ReturnType<FastifyInstance['inject']>>): string {
  return setCookieHeader(response).split(';')[0] ?? '';
}

describe('dashboard authentication', () => {
  it('signs in with the configured administrator and sets a signed HttpOnly session cookie', async () => {
    const app = buildStubApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: TEST_AUTH.email, password: TEST_AUTH.password },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { email: TEST_AUTH.email } });

    const header = setCookieHeader(response);
    expect(header).toContain('ss_session=');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=');
    expect(header).not.toContain('Secure');

    const cookie = sessionCookie(response);
    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().data.workspace.name).toBe('SS Tool workspace');

    await app.close();
  });

  it('rejects invalid credentials without setting a session', async () => {
    const app = buildStubApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: TEST_AUTH.email, password: 'definitely-the-wrong-password' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });
    expect(response.headers['set-cookie']).toBeUndefined();

    await app.close();
  });

  it('returns 503 when login is not configured and keeps the public site available', async () => {
    const app = buildApp({ database: stubDatabase(), logger: false });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin@ss-tool.test', password: 'test-password-long-enough' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'AUTH_NOT_CONFIGURED' } });

    const loginPage = await app.inject({ method: 'GET', url: '/login' });
    expect(loginPage.statusCode).toBe(200);

    const landing = await app.inject({ method: 'GET', url: '/' });
    expect(landing.statusCode).toBe(200);

    await app.close();
  });

  it('marks the cookie Secure in production mode', async () => {
    const app = buildStubApp({ ...TEST_AUTH, secureCookies: true });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: TEST_AUTH.email, password: TEST_AUTH.password },
    });

    expect(response.statusCode).toBe(200);
    expect(setCookieHeader(response)).toContain('Secure');

    await app.close();
  });

  it('expires sessions after the configured lifetime', async () => {
    const app = buildStubApp({ ...TEST_AUTH, sessionTtlMs: 30 });

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: TEST_AUTH.email, password: TEST_AUTH.password },
    });
    const cookie = sessionCookie(loginResponse);

    await new Promise((resolve) => setTimeout(resolve, 80));

    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    expect(session.statusCode).toBe(401);

    const dashboard = await app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } });
    expect(dashboard.statusCode).toBe(302);
    expect(dashboard.headers.location).toContain('/login?next=');

    await app.close();
  });

  it('destroys the session on logout', async () => {
    const app = buildStubApp();

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: TEST_AUTH.email, password: TEST_AUTH.password },
    });
    const cookie = sessionCookie(loginResponse);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(200);
    expect(setCookieHeader(logout)).toContain('ss_session=');

    const afterLogout = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    expect(afterLogout.statusCode).toBe(401);

    await app.close();
  });

  it('rejects a tampered session cookie', async () => {
    const app = buildStubApp();

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: TEST_AUTH.email, password: TEST_AUTH.password },
    });
    const cookie = sessionCookie(loginResponse);
    const tampered = `${cookie.slice(0, -2)}xx`;

    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: tampered },
    });
    expect(session.statusCode).toBe(401);

    await app.close();
  });

  it('rate-limits repeated failed logins', async () => {
    const app = buildStubApp();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: TEST_AUTH.email, password: `wrong-password-${attempt}` },
      });
      expect(response.statusCode).toBe(401);
    }

    const limited = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: TEST_AUTH.email, password: TEST_AUTH.password },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'LOGIN_RATE_LIMITED' } });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    await app.close();
  });

  it('redirects unauthenticated dashboard pages to login with a safe next path', async () => {
    const app = buildStubApp();

    for (const path of ['/dashboard', '/dashboard/products', '/dashboard/import']) {
      const response = await app.inject({ method: 'GET', url: path });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(
        `/login?next=${encodeURIComponent(path === '/dashboard' ? '/dashboard' : path)}`,
      );
    }

    await app.close();
  });

  it('protects retailer-management APIs and keeps public APIs reachable', async () => {
    const app = buildStubApp();

    const privateCalls = [
      { method: 'GET' as const, url: '/api/v1/manufacturers' },
      { method: 'GET' as const, url: '/api/v1/products' },
      { method: 'POST' as const, url: '/api/v1/catalogue/imports' },
      { method: 'GET' as const, url: '/api/v1/evidence/pending' },
      { method: 'GET' as const, url: '/api/v1/dashboard/summary' },
    ];

    for (const call of privateCalls) {
      const response = await app.inject(call);
      expect(response.statusCode, `${call.method} ${call.url}`).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
    }

    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);

    await app.close();
  });

  it('serves the dashboard shell only to an authenticated session', async () => {
    const app = buildStubApp();
    await app.ready();
    const cookie = await login(app);

    for (const path of ['/dashboard', '/dashboard/products', '/dashboard/import']) {
      const response = await app.inject({ method: 'GET', url: path, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('id="view"');
      expect(response.body).toContain('/dashboard.js');
    }

    const loginPage = await app.inject({ method: 'GET', url: '/login', headers: { cookie } });
    expect(loginPage.statusCode).toBe(302);
    expect(loginPage.headers.location).toBe('/dashboard');

    await app.close();
  });
});

describe('dashboard summary and catalogue API', () => {
  let app: FastifyInstance;
  let database: Database;
  let cookie: string;
  let manufacturerId: string;
  let sourceId: string;
  let firstProductId: string;
  let secondProductId: string;
  let baseline: {
    products: { total: number; withSources: number; withoutSources: number; withAcceptedEvidence: number };
    manufacturers: { total: number };
    evidence: { pendingReview: number };
  };

  beforeAll(async () => {
    loadEnv();
    database = createDatabase(loadEnv().DATABASE_URL);
    await migrate(database.orm, { migrationsFolder: 'drizzle' });
    app = buildApp({ database, logger: false, auth: TEST_AUTH });
    await app.ready();
    cookie = await login(app);

    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/summary',
      headers: { cookie },
    });
    expect(before.statusCode).toBe(200);
    baseline = before.json().data;

    const [manufacturer] = await database.client`
      insert into manufacturers (name, normalized_name, website, country_code)
      values (${`${TEST_PREFIX} Maker`}, ${`${TEST_PREFIX} maker`.toLowerCase()}, 'https://step9.test', 'GB')
      returning id
    `;
    manufacturerId = manufacturer!.id as string;

    const [first] = await database.client`
      insert into products (manufacturer_id, name, model_identifier, category)
      values (${manufacturerId}, ${`${TEST_PREFIX} Pending`}, ${`S9-${RUN_ID}-1`}, 'Home hub')
      returning id
    `;
    firstProductId = first!.id as string;

    const [second] = await database.client`
      insert into products (manufacturer_id, name, model_identifier, category)
      values (${manufacturerId}, ${`${TEST_PREFIX} Accepted`}, ${`S9-${RUN_ID}-2`}, 'Camera')
      returning id
    `;
    secondProductId = second!.id as string;

    const [source] = await database.client`
      insert into sources (url, domain, title, content_text, http_status, fetched_at)
      values (
        ${`https://step9-${RUN_ID}.test/support`},
        ${`step9-${RUN_ID}.test`},
        'Support policy',
        'Security updates until December 31, 2030.',
        200,
        now()
      )
      returning id
    `;
    sourceId = source!.id as string;

    await database.client`
      insert into product_sources (product_id, source_id, relationship_type)
      values
        (${firstProductId}, ${sourceId}, 'support_page'),
        (${secondProductId}, ${sourceId}, 'support_page')
    `;

    await database.client`
      insert into evidence (
        product_id, source_id, claim_type, raw_text, quoted_excerpt,
        date_text, date_precision, normalized_date, confidence,
        explanation, extraction_method, review_status
      )
      values
        (
          ${firstProductId}, ${sourceId}, 'support_end',
          'Security updates until December 31, 2030.',
          'Security updates until December 31, 2030.',
          'December 31, 2030', 'day', '2030-12-31', 0.9,
          'Pending review fixture.', 'manual', 'pending'
        ),
        (
          ${secondProductId}, ${sourceId}, 'support_end',
          'Security updates until December 31, 2030.',
          'Security updates until December 31, 2030.',
          'December 31, 2030', 'day', '2030-12-31', 0.9,
          'Accepted review fixture.', 'manual', 'accepted'
        )
    `;
  });

  afterAll(async () => {
    if (database && manufacturerId) {
      await database.client`delete from products where manufacturer_id = ${manufacturerId}`;
      await database.client`delete from manufacturers where id = ${manufacturerId}`;
      if (sourceId) await database.client`delete from sources where id = ${sourceId}`;
    }
    await app?.close();
    if (database) await closeDatabase(database);
  });

  it('returns PostgreSQL aggregates and the five most recent products', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/summary',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);

    const summary = response.json().data;
    expect(summary.products.total - baseline.products.total).toBe(2);
    expect(summary.products.withSources - baseline.products.withSources).toBe(2);
    expect(summary.products.withoutSources - baseline.products.withoutSources).toBe(0);
    expect(summary.products.withAcceptedEvidence - baseline.products.withAcceptedEvidence).toBe(1);
    expect(summary.manufacturers.total - baseline.manufacturers.total).toBe(1);
    expect(summary.evidence.pendingReview - baseline.evidence.pendingReview).toBe(1);

    expect(summary.recentProducts.length).toBeLessThanOrEqual(5);
    const recentIds = summary.recentProducts.map((product: { id: string }) => product.id);
    expect(recentIds).toContain(secondProductId);
    expect(recentIds.indexOf(secondProductId)).toBeLessThan(recentIds.indexOf(firstProductId));

    const second = summary.recentProducts.find(
      (product: { id: string }) => product.id === secondProductId,
    );
    expect(second.manufacturer.name).toBe(`${TEST_PREFIX} Maker`);
  });

  it('returns zero counts and no recent products for an empty catalogue', async () => {
    let emptySummary: Awaited<ReturnType<ReturnType<typeof createDashboardRepository>['getSummary']>> | null =
      null;

    try {
      await database.orm.transaction(async (transaction) => {
        await transaction.delete(evidenceReviews);
        await transaction.delete(evidence);
        await transaction.delete(productSources);
        await transaction.delete(products);
        await transaction.delete(sources);
        await transaction.delete(manufacturers);

        emptySummary = await createDashboardRepository(transaction).getSummary();
        throw new Error('ROLLBACK_EMPTY_DASHBOARD_TEST');
      });
    } catch (error) {
      expect((error as Error).message).toBe('ROLLBACK_EMPTY_DASHBOARD_TEST');
    }

    expect(emptySummary).not.toBeNull();
    expect(emptySummary).toMatchObject({
      products: { total: 0, withSources: 0, withoutSources: 0, withAcceptedEvidence: 0 },
      manufacturers: { total: 0 },
      evidence: { pendingReview: 0 },
      recentProducts: [],
    });
  });

  it('lists products with pagination and manufacturer names available for the filter', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/products?page=1&pageSize=2',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.pagination).toMatchObject({ page: 1, pageSize: 2 });
    expect(body.pagination.total).toBeGreaterThanOrEqual(2);
    expect(body.data.length).toBeLessThanOrEqual(2);
    expect(body.data[0]).toHaveProperty('manufacturerId');

    const manufacturersResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/manufacturers',
      headers: { cookie },
    });
    expect(manufacturersResponse.statusCode).toBe(200);
    expect(
      manufacturersResponse
        .json()
        .data.some((manufacturer: { id: string; name: string }) => manufacturer.id === manufacturerId),
    ).toBe(true);
  });

  it('filters the catalogue by manufacturer', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/products?manufacturerId=${manufacturerId}&page=1&pageSize=20`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.pagination.total).toBe(2);
    expect(body.data).toHaveLength(2);
    expect(
      body.data.every((product: { manufacturerId: string }) => product.manufacturerId === manufacturerId),
    ).toBe(true);
  });

  it('keeps public support APIs reachable without a session', async () => {
    const supportCard = await app.inject({
      method: 'GET',
      url: '/api/v1/public/products/00000000-0000-4000-8000-000000000001/support-card',
    });
    expect(supportCard.statusCode).toBe(404);

    const lookup = await app.inject({ method: 'GET', url: '/api/v1/public/products/lookup' });
    expect(lookup.statusCode).toBe(400);

    const home = await app.inject({ method: 'GET', url: '/' });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('Know how long your devices will stay supported.');
  });
});
