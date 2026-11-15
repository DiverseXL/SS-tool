import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { closeDatabase, createDatabase, type Database } from '../src/db/client.js';
import { AiProviderError, type AiCompletionRequest, type AiProvider } from '../src/extraction/provider.js';
import { DEMO_EXTRACTION_PRODUCTS } from '../src/public/demo-extract-products.js';
import { TEST_AUTH } from './helpers/test-auth.js';

const DEFAULT_CLAIMS = JSON.stringify({
  claims: [
    {
      claimType: 'support_end',
      statement: 'Security updates for the Halo S1 will be provided until 31 December 2030.',
      quotation: 'Security updates for the Halo S1 will be provided until 31 December 2030.',
      dateText: '31 December 2030',
      confidence: 0.98,
      explanation: 'Explicit support end date extracted by SERV.',
    },
  ],
});

class MockServProvider implements AiProvider {
  readonly name = 'openserv-serv:gpt-5.4-mini';
  readonly isServ = true;
  callCount = 0;
  responseText: string | null = null;
  error: Error | null = null;
  requests: AiCompletionRequest[] = [];

  async complete(request: AiCompletionRequest) {
    this.callCount += 1;
    this.requests.push(request);
    if (this.error) throw this.error;
    return {
      text: this.responseText ?? DEFAULT_CLAIMS,
      model: 'gpt-5.4-mini',
      requestId: 'chatcmpl-mock-demo-001',
      durationMs: 245,
      usage: { inputTokens: 450, outputTokens: 85, totalTokens: 535 },
    };
  }

  reset(): void {
    this.callCount = 0;
    this.responseText = null;
    this.error = null;
    this.requests = [];
  }
}

let app: FastifyInstance;
let database: Database;
let mockProvider: MockServProvider;

beforeAll(async () => {
  loadEnv();
  database = createDatabase(loadEnv().DATABASE_URL);
  await migrate(database.orm, { migrationsFolder: 'drizzle' });
  mockProvider = new MockServProvider();
  app = buildApp({
    database,
    logger: false,
    auth: TEST_AUTH,
    extraction: { provider: mockProvider },
  });
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (database) await closeDatabase(database);
});

describe('POST /api/v1/public/demo/extract (live SERV preview)', () => {
  it('1. registers the exact route instead of returning 404', async () => {
    mockProvider.reset();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/public/demo/extract',
      payload: { demoProductId: 'demo-northline-halo-s1' },
    });

    expect(response.statusCode).not.toBe(404);
    expect(response.statusCode).toBe(200);
  });

  it('2. runs the extraction pipeline for a predefined demo product', async () => {
    mockProvider.reset();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/public/demo/extract',
      payload: { demoProductId: 'demo-northline-halo-s1' },
    });

    expect(response.statusCode).toBe(200);
    expect(mockProvider.callCount).toBe(1);

    const data = response.json().data;
    expect(data.demonstration).toBe(true);
    expect(data.isLiveExtraction).toBe(true);
    expect(data.provider).toBe('OpenServ SERV');
    expect(data.model).toBe('gpt-5.4-mini');
    expect(data.requestId).toBe('chatcmpl-mock-demo-001');
    expect(data.durationMs).toBe(245);
    expect(data.usage).toEqual({ promptTokens: 450, completionTokens: 85, totalTokens: 535 });
    expect(data.product).toMatchObject({
      id: 'demo-northline-halo-s1',
      name: 'Halo S1 Home Speaker',
      manufacturer: 'Northline Audio',
    });

    const claim = data.claims[0];
    expect(claim.claimType).toBe('support_end');
    expect(claim.reviewStatus).toBe('pending');
    expect(claim.validation.quotationMatched).toBe(true);
    expect(claim.validation.dateSupportedInQuotation).toBe(true);
    expect(claim.validation.semanticsValid).toBe(true);
    expect(claim.normalizedDate).toBe('2030-12-31');
  });

  it('3. rejects an unknown demo product without calling SERV', async () => {
    mockProvider.reset();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/public/demo/extract',
      payload: { demoProductId: 'arbitrary-product' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_DEMO_PRODUCT');
    expect(mockProvider.callCount).toBe(0);
  });

  it('4. ignores client-supplied URLs, source text and product fields', async () => {
    mockProvider.reset();
    const attackerText = 'ATTACKER CONTENT: support lasts forever';

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/public/demo/extract',
      payload: {
        demoProductId: 'demo-apex-hub-max',
        sourceUrl: 'https://attacker.example/page',
        url: 'https://attacker.example/page',
        contentText: attackerText,
        sourceText: attackerText,
        manufacturer: 'Attacker Corp',
        productName: 'Fake Product',
        model: 'evil-model',
        apiKey: 'attacker-key',
      },
    });

    expect(response.statusCode).toBe(200);
    const predefined = DEMO_EXTRACTION_PRODUCTS.find((p) => p.id === 'demo-apex-hub-max')!;
    expect(response.json().data.source.url).toBe(predefined.source.url);
    expect(response.json().data.product.manufacturer).toBe(predefined.manufacturer);

    const sent = mockProvider.requests[0]!;
    expect(sent.userPrompt).toContain('Apex Hub Max');
    expect(sent.userPrompt).not.toContain(attackerText);
    expect(sent.userPrompt).not.toContain('attacker.example');
  });

  it('5. maps SERV rate limits and timeouts to safe HTTP errors', async () => {
    mockProvider.reset();
    mockProvider.error = new AiProviderError('HTTP_ERROR', 'rate limited', { providerStatus: 429 });
    const limited = await app.inject({
      method: 'POST',
      url: '/api/v1/public/demo/extract',
      payload: { demoProductId: 'demo-northline-halo-s1' },
      remoteAddress: '10.10.0.1',
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('AI_PROVIDER_RATE_LIMITED');

    mockProvider.reset();
    mockProvider.error = new AiProviderError('TIMEOUT', 'provider timed out');
    const timeout = await app.inject({
      method: 'POST',
      url: '/api/v1/public/demo/extract',
      payload: { demoProductId: 'demo-northline-halo-s1' },
      remoteAddress: '10.10.0.2',
    });
    expect(timeout.statusCode).toBe(504);
    expect(timeout.json().error.code).toBe('AI_PROVIDER_TIMEOUT');
  });

  it('6. keeps invalid quotations out of the valid claims while still pending review', async () => {
    mockProvider.reset();
    mockProvider.responseText = JSON.stringify({
      claims: [
        {
          claimType: 'support_end',
          statement: 'Support ends in 2035.',
          quotation: 'Support is guaranteed until 2035.',
          dateText: '2035',
          confidence: 0.9,
          explanation: 'Unsupported paraphrase.',
        },
      ],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/public/demo/extract',
      payload: { demoProductId: 'demo-northline-halo-s1' },
      remoteAddress: '10.10.0.3',
    });

    expect(response.statusCode).toBe(200);
    const claim = response.json().data.claims[0];
    expect(claim.validation.quotationMatched).toBe(false);
    expect(claim.validation.rejectionReason).toBeTruthy();
    expect(claim.reviewStatus).toBe('pending');
  });

  it('7. does not persist preview evidence to PostgreSQL', async () => {
    mockProvider.reset();
    const before = await database.client`
      select count(*)::int as count from evidence where quoted_excerpt like '%Halo S1%'
    `;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/public/demo/extract',
      payload: { demoProductId: 'demo-northline-halo-s1' },
      remoteAddress: '10.10.0.4',
    });
    expect(response.statusCode).toBe(200);

    const after = await database.client`
      select count(*)::int as count from evidence where quoted_excerpt like '%Halo S1%'
    `;
    expect(after[0]?.count).toBe(before[0]?.count);
  });

  it('8. marks every returned claim as pending human review', async () => {
    mockProvider.reset();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/public/demo/extract',
      payload: { demoProductId: 'demo-apex-hub-max' },
      remoteAddress: '10.10.0.5',
    });

    expect(response.statusCode).toBe(200);
    const claims = response.json().data.claims as Array<{ reviewStatus: string }>;
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) expect(claim.reviewStatus).toBe('pending');
    expect(response.json().data.disclaimer).toContain('pending human review');
  });

  it('9. requires no authentication for the restricted demo endpoint', async () => {
    mockProvider.reset();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/public/demo/extract',
      payload: { demoProductId: 'demo-northline-halo-s1' },
      remoteAddress: '10.10.0.6',
      // Deliberately no session cookie.
    });

    expect(response.statusCode).toBe(200);
  });

  it('10. keeps private extraction and review endpoints protected', async () => {
    const extraction = await app.inject({
      method: 'POST',
      url: '/api/v1/products/00000000-0000-4000-8000-000000000000/extract-evidence',
    });
    expect(extraction.statusCode).toBe(401);
    expect(extraction.json().error.code).toBe('AUTH_REQUIRED');

    const review = await app.inject({ method: 'GET', url: '/api/v1/dashboard/evidence-queue' });
    expect(review.statusCode).toBe(401);

    const reviewAction = await app.inject({
      method: 'POST',
      url: '/api/v1/evidence/00000000-0000-4000-8000-000000000000/review',
      payload: { decision: 'accepted', note: 'should not be reachable' },
    });
    expect(reviewAction.statusCode).toBe(401);
  });

  it('11. rejects malformed model output with a clean error and no persistence', async () => {
    mockProvider.reset();
    mockProvider.responseText = 'not json at all';

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/public/demo/extract',
      payload: { demoProductId: 'demo-northline-halo-s1' },
      remoteAddress: '10.10.0.7',
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('AI_RESPONSE_INVALID');
    expect(response.body).not.toContain(mockProvider.responseText);
  });

  it('12. rate limits repeated demonstration requests per IP', async () => {
    mockProvider.reset();
    const clientIp = '10.10.1.99';
    let limited = false;

    for (let i = 0; i < 12; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/public/demo/extract',
        payload: { demoProductId: 'demo-northline-halo-s1' },
        remoteAddress: clientIp,
      });
      if (response.statusCode === 429) {
        limited = true;
        expect(response.json().error.code).toBe('RATE_LIMIT_EXCEEDED');
        break;
      }
    }

    expect(limited).toBe(true);
  });
});
