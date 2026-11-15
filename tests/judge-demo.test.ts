import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { closeDatabase, createDatabase, type Database } from '../src/db/client.js';
import type { PublicService } from '../src/public/public-service.js';
import { createJudgeDemoService } from '../src/public/judge-demo.js';
import { seedJudgeDemo } from '../src/public/demo-seed.js';
import { DEMO_PRODUCTS, DEMO_SOURCE } from '../src/public/demo-dataset.js';
import { AppError } from '../src/lib/errors.js';
import { TEST_AUTH, authHeaders, login } from './helpers/test-auth.js';

let app: FastifyInstance;
let database: Database;

beforeAll(async () => {
  loadEnv();
  database = createDatabase(loadEnv().DATABASE_URL);
  await migrate(database.orm, { migrationsFolder: 'drizzle' });
  await seedJudgeDemo(database);
  app = buildApp({
    database,
    logger: false,
    auth: TEST_AUTH,
    extraction: { provider: null },
  });
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (database) await closeDatabase(database);
});

describe('Public judge demo', () => {
  it('1. serves /demo without a login session', async () => {
    const response = await app.inject({ method: 'GET', url: '/demo' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toContain('HackOnVibe judge demo');
    expect(response.body).toContain('Read-only');
    expect(response.body).toContain('Explore how SS Tool helps retailers understand how long connected products receive');
    expect(response.body).toContain('src="/demo.js"');
    expect(response.body).not.toContain('/dashboard/import');
  });

  it('2. redirects the demo HTML aliases to /demo', async () => {
    const trailing = await app.inject({ method: 'GET', url: '/demo/' });
    expect(trailing.statusCode).toBe(302);
    expect(trailing.headers.location).toBe('/demo');

    const html = await app.inject({ method: 'GET', url: '/demo.html' });
    expect(html.statusCode).toBe(302);
    expect(html.headers.location).toBe('/demo');
  });

  it('3. lists only the curated demonstration dataset', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/public/demo/products' });

    expect(response.statusCode).toBe(200);
    const products = response.json().data as Array<Record<string, unknown>>;
    expect(products.map((product) => product.id)).toEqual(DEMO_PRODUCTS.map((product) => product.id));
    expect(products).toHaveLength(3);
    expect(new Set(products.map((product) => product.id)).size).toBe(3);
    for (const product of products) {
      expect(product.demonstration).toBe(true);
      expect(product.status).toBe('INFORMATION_AVAILABLE');
      expect(product.sourceCount).toBe(1);
      expect(product.claimCount).toBe(1);
    }
  });

  it('4. obtains every demo summary from the existing public support-card service', async () => {
    const listResponse = await app.inject({ method: 'GET', url: '/api/v1/public/demo/products' });
    const products = listResponse.json().data as Array<Record<string, any>>;

    for (const item of products) {
      const cardResponse = await app.inject({
        method: 'GET',
        url: `/api/v1/public/products/${item.id}/support-card`,
      });
      expect(cardResponse.statusCode).toBe(200);
      const card = cardResponse.json().data;

      expect(item.name).toBe(card.product.name);
      expect(item.manufacturer).toBe(card.product.manufacturer.name);
      expect(item.modelIdentifier).toBe(card.product.modelIdentifier);
      expect(item.status).toBe(card.supportInformation.status);
      expect(item.summaryStatement).toBe(card.supportInformation.summaryStatement);
      expect(item.supportEnd).toEqual(card.supportInformation.supportEnd);
      expect(item.claimCount).toBe(card.supportInformation.claims.length);
      expect(item.sourceCount).toBe(card.supportInformation.sources.length);
      expect(item.lastUpdated).toBe(card.lastUpdated);
    }
  });

  it('5. preserves year precision without inventing a day', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/public/products/a2222222-2222-4222-8222-222222222203/support-card',
    });

    expect(response.statusCode).toBe(200);
    const card = response.json().data;
    expect(card.supportInformation.status).toBe('INFORMATION_AVAILABLE');
    expect(card.supportInformation.supportEnd).toEqual({
      value: null,
      displayValue: '2033',
      precision: 'year',
    });
    expect(card.supportInformation.claims).toHaveLength(1);
    expect(card.supportInformation.claims[0].source.url).toBe(DEMO_SOURCE.url);
    expect(card.supportInformation.claims[0].quotation).toContain('until 2033');
    expect(card.supportInformation.claims[0].reviewStatus).toBe('accepted');
  });

  it('6. shows a policy-only product without manufacturing an end date', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/public/products/a2222222-2222-4222-8222-222222222202/support-card',
    });

    expect(response.statusCode).toBe(200);
    const card = response.json().data;
    expect(card.supportInformation.status).toBe('INFORMATION_AVAILABLE');
    expect(card.supportInformation.supportEnd).toBeNull();
    expect(card.supportInformation.claims[0].claimType).toBe('policy');
    expect(card.supportInformation.policyStatements[0]).toContain('eight years of security updates');
  });

  it('7. exposes accepted evidence but no private review or extraction data', async () => {
    const demoResponse = await app.inject({ method: 'GET', url: '/api/v1/public/demo/products' });
    const cardResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/public/products/a2222222-2222-4222-8222-222222222201/support-card',
    });

    for (const body of [demoResponse.body, cardResponse.body]) {
      expect(body).not.toContain('Judge demo seed');
      expect(body).not.toContain('Curated from');
      expect(body).not.toContain('reviewNote');
      expect(body).not.toContain('confidence');
      expect(body).not.toContain('contentText');
      expect(body).not.toContain('claimFingerprint');
      expect(body).not.toContain('reviewer');
    }
    expect(cardResponse.json().data.supportInformation.claims[0].reviewStatus).toBe('accepted');
  });

  it('8. seeds repeatedly without duplicate products, sources or evidence', async () => {
    const before = await database.client`
      select
        (select count(*)::int from products where id in ${database.client(DEMO_PRODUCTS.map((product) => product.id))}) as products,
        (select count(*)::int from sources where url = ${DEMO_SOURCE.url}) as sources,
        (select count(*)::int from evidence where claim_fingerprint like 'fairphone-support-v1:%') as evidence,
        (select count(*)::int from evidence_reviews r join evidence e on e.id = r.evidence_id
          where e.claim_fingerprint like 'fairphone-support-v1:%') as reviews
    `;

    await seedJudgeDemo(database);
    await seedJudgeDemo(database);

    const after = await database.client`
      select
        (select count(*)::int from products where id in ${database.client(DEMO_PRODUCTS.map((product) => product.id))}) as products,
        (select count(*)::int from sources where url = ${DEMO_SOURCE.url}) as sources,
        (select count(*)::int from evidence where claim_fingerprint like 'fairphone-support-v1:%') as evidence,
        (select count(*)::int from evidence_reviews r join evidence e on e.id = r.evidence_id
          where e.claim_fingerprint like 'fairphone-support-v1:%') as reviews
    `;

    expect(after[0]).toEqual(before[0]);
    expect(after[0]?.products).toBe(3);
    expect(after[0]?.sources).toBe(1);
    expect(after[0]?.evidence).toBe(3);
    expect(after[0]?.reviews).toBe(3);
  });

  it('9. returns useful empty data, rather than an error, when demo products are missing', async () => {
    const missingPublicService = {
      async getSupportCard() {
        throw AppError.notFound('PRODUCT_NOT_FOUND', 'Product not found');
      },
    } as unknown as Pick<PublicService, 'getSupportCard'>;

    const service = createJudgeDemoService(missingPublicService);
    await expect(service.listDemoProducts()).resolves.toEqual([]);
  });

  it('10. exposes static loading and error states in the demo client', async () => {
    const response = await app.inject({ method: 'GET', url: '/demo.js' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Demonstration data is not available yet.');
    expect(response.body).toContain('The demonstration is temporarily unavailable');
    expect(response.body).toContain('Try again');
  });

  it('11. keeps dashboard, catalogue, research and review APIs private', async () => {
    const evidenceId = DEMO_PRODUCTS[0]!.claims[0]!.id;
    const productId = DEMO_PRODUCTS[0]!.id;
    const requests = [
      { method: 'GET' as const, url: '/api/v1/dashboard/evidence-queue' },
      { method: 'GET' as const, url: '/api/v1/products' },
      { method: 'POST' as const, url: `/api/v1/evidence/${evidenceId}/review`, payload: { decision: 'accepted', reviewNote: 'Unauthenticated attempt' } },
      { method: 'POST' as const, url: `/api/v1/products/${productId}/research` },
      { method: 'POST' as const, url: `/api/v1/products/${productId}/extract-evidence` },
      { method: 'POST' as const, url: '/api/v1/catalogue/imports' },
    ];

    for (const request of requests) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('AUTH_REQUIRED');
    }
  });

  it('12. exposes only the restricted live extraction endpoint, never a public review action', async () => {
    const extract = await app.inject({
      method: 'POST',
      url: '/api/v1/public/demo/extract',
      payload: { demoProductId: 'demo-northline-halo-s1' },
    });
    // The endpoint exists; this app instance has no SERV provider configured.
    expect(extract.statusCode).toBe(503);
    expect(extract.json().error.code).toBe('AI_NOT_CONFIGURED');

    const review = await app.inject({
      method: 'POST',
      url: `/api/v1/public/evidence/${DEMO_PRODUCTS[0]!.claims[0]!.id}/review`,
      payload: { decision: 'accepted', reviewNote: 'Public attempt' },
    });
    expect(review.statusCode).toBe(404);
  });

  it('13. still serves the private dashboard to an authenticated administrator', async () => {
    await login(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/summary',
      headers: authHeaders(app),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.products.total).toBeGreaterThanOrEqual(3);
  });
});
