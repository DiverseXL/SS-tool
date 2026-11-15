import { createServer } from 'node:http';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { closeDatabase, createDatabase, type Database } from '../src/db/client.js';
import type { AiCompletionRequest, AiCompletionResult, AiProvider } from '../src/extraction/provider.js';
import { AiProviderError } from '../src/extraction/provider.js';
import { authCookie, login, TEST_AUTH } from './helpers/test-auth.js';

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PREFIX = `Step5 Test ${RUN_ID}`;
const HOST = `maker-${RUN_ID}.test`;
const BASE = `https://${HOST}`;
const RETAILER_HOST = `retailer-${RUN_ID}.example`;

class FakeProvider implements AiProvider {
  readonly name = 'fake-extraction-provider';
  readonly calls: AiCompletionRequest[] = [];
  respond: (request: AiCompletionRequest) => string | Promise<string> = () =>
    JSON.stringify({ claims: [] });

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    this.calls.push(request);
    return { text: await this.respond(request), model: 'fake-model' };
  }

  reset(): void {
    this.calls.length = 0;
    this.respond = () => JSON.stringify({ claims: [] });
  }
}

function failingProvider(error: AiProviderError): AiProvider {
  return {
    name: 'failing-provider',
    async complete() {
      throw error;
    },
  };
}

interface ClaimInput {
  claimType?: string;
  statement?: string;
  quotation: string;
  dateText?: string | null;
  confidence?: number;
  explanation?: string;
}

function claim(input: ClaimInput): Record<string, unknown> {
  return {
    claimType: 'support_end',
    statement: input.statement ?? input.quotation,
    dateText: null,
    confidence: 0.9,
    explanation: 'The manufacturer states this explicitly.',
    ...input,
  };
}

function claimsResponse(...claims: Array<Record<string, unknown>>): string {
  return JSON.stringify({ claims });
}

let app: FastifyInstance;
let unconfiguredApp: FastifyInstance;
let timeoutApp: FastifyInstance;
let providerErrorApp: FastifyInstance;
let database: Database;
let fakeProvider: FakeProvider;
let manufacturerId: string;
let sequence = 0;

function post(url: string, payload?: unknown, target: FastifyInstance = app) {
  return target.inject({
    method: 'POST',
    url,
    payload: payload as object | undefined,
    headers: { cookie: authCookie(target) },
  });
}

function extract(productId: string, target: FastifyInstance = app) {
  return post(`/api/v1/products/${productId}/extract-evidence`, undefined, target);
}

async function createProduct(overrides: Record<string, unknown> = {}) {
  sequence += 1;
  const response = await post('/api/v1/products', {
    manufacturerId,
    name: `${TEST_PREFIX} Product ${sequence}`,
    modelIdentifier: `S5-${RUN_ID}-${sequence}`,
    ...overrides,
  });
  expect(response.statusCode).toBe(201);
  return response.json().data as { id: string };
}

interface AddSourceOptions {
  content: string | null;
  relationshipType?:
    | 'manufacturer_homepage'
    | 'product_page'
    | 'support_page'
    | 'security_advisory'
    | 'policy_page'
    | 'discovered_candidate';
  url?: string;
  domain?: string;
  httpStatus?: number | null;
  title?: string | null;
}

async function addSource(productId: string, options: AddSourceOptions): Promise<string> {
  sequence += 1;
  const url = options.url ?? `${BASE}/support/source-${sequence}`;
  const domain = options.domain ?? new URL(url).hostname;
  const httpStatus = options.httpStatus === undefined ? 200 : options.httpStatus;

  const [source] = await database.client`
    insert into sources (url, domain, title, content_text, http_status, fetched_at)
    values (${url}, ${domain}, ${options.title ?? 'Support page'}, ${options.content}, ${httpStatus}, now())
    on conflict (url) do update set
      domain = excluded.domain,
      title = excluded.title,
      content_text = excluded.content_text,
      http_status = excluded.http_status,
      fetched_at = excluded.fetched_at
    returning id
  `;

  await database.client`
    insert into product_sources (product_id, source_id, relationship_type)
    values (${productId}, ${source?.id}, ${options.relationshipType ?? 'support_page'})
    on conflict do nothing
  `;

  return source?.id as string;
}

async function createProductWithSource(options: AddSourceOptions) {
  const product = await createProduct();
  const sourceId = await addSource(product.id, options);
  return { productId: product.id, sourceId };
}

async function evidenceRows(productId: string) {
  return database.client`
    select id, claim_type, raw_text, quoted_excerpt, date_text, date_precision,
           normalized_date, confidence, extraction_method, review_status, claim_fingerprint
    from evidence
    where product_id = ${productId}
    order by created_at asc
  `;
}

beforeAll(async () => {
  loadEnv();
  database = createDatabase(loadEnv().DATABASE_URL);
  await migrate(database.orm, { migrationsFolder: 'drizzle' });

  fakeProvider = new FakeProvider();
  app = buildApp({
    database,
    logger: false,
    auth: TEST_AUTH,
    extraction: { provider: fakeProvider },
  });
  await app.ready();
  await login(app);

  unconfiguredApp = buildApp({
    database,
    logger: false,
    auth: TEST_AUTH,
    extraction: { provider: null },
  });
  await unconfiguredApp.ready();
  await login(unconfiguredApp);

  timeoutApp = buildApp({
    database,
    logger: false,
    auth: TEST_AUTH,
    extraction: { provider: failingProvider(new AiProviderError('TIMEOUT', 'timed out')) },
  });
  await timeoutApp.ready();
  await login(timeoutApp);

  providerErrorApp = buildApp({
    database,
    logger: false,
    auth: TEST_AUTH,
    extraction: { provider: failingProvider(new AiProviderError('HTTP_ERROR', 'upstream failed')) },
  });
  await providerErrorApp.ready();
  await login(providerErrorApp);

  const response = await post('/api/v1/manufacturers', {
    name: `${TEST_PREFIX} Maker`,
    website: BASE,
  });
  expect(response.statusCode).toBe(201);
  manufacturerId = response.json().data.id;
});

beforeEach(() => {
  fakeProvider.reset();
});

afterAll(async () => {
  if (database) {
    const likePattern = `${TEST_PREFIX.toLowerCase()}%`;
    await database.client`
      delete from products
      where manufacturer_id in (
        select id from manufacturers where normalized_name like ${likePattern}
      )
    `;
    await database.client`delete from manufacturers where normalized_name like ${likePattern}`;
    await database.client`delete from sources where url like ${`%${RUN_ID}%`}`;
  }

  await app?.close();
  await unconfiguredApp?.close();
  await timeoutApp?.close();
  await providerErrorApp?.close();
  if (database) await closeDatabase(database);
});

describe('POST /api/v1/products/:id/extract-evidence', () => {
  it('extracts a support-end claim and stores it as pending AI evidence', async () => {
    const quotation = 'Security updates will be provided until December 2030.';
    const { productId } = await createProductWithSource({
      content: `Acme lifecycle information.\n\n${quotation}\n\nFurther details.`,
    });

    fakeProvider.respond = () =>
      claimsResponse(
        claim({
          claimType: 'support_end',
          statement: 'Security updates are provided until December 2030.',
          quotation,
          dateText: 'December 2030',
          confidence: 0.94,
        }),
      );

    const response = await extract(productId);
    expect(response.statusCode).toBe(200);

    const body = response.json().data;
    expect(body).toMatchObject({
      productId,
      sourcesProcessed: 1,
      sourcesSkipped: 0,
      claimsExtracted: 1,
      claimsStored: 1,
      claimsRejected: 0,
      duplicateClaims: 0,
    });
    expect(body.storedClaims[0]).toMatchObject({
      evidenceId: expect.any(String),
      claimType: 'support_end',
      statement: 'Security updates are provided until December 2030.',
      quotation,
      dateText: 'December 2030',
      datePrecision: 'month',
      normalizedDate: null,
      reviewStatus: 'pending',
    });

    const rows = await evidenceRows(productId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      claim_type: 'support_end',
      date_text: 'December 2030',
      date_precision: 'month',
      normalized_date: null,
      extraction_method: 'ai',
      review_status: 'pending',
      claim_fingerprint: expect.any(String),
    });
  });

  it('extracts a support-start claim with an explicitly stated full date', async () => {
    const quotation = 'Security support begins on 1 January 2027.';
    const { productId } = await createProductWithSource({
      content: `Support timeline.\n\n${quotation}`,
    });

    fakeProvider.respond = () =>
      claimsResponse(
        claim({
          claimType: 'support_start',
          statement: 'Security support starts on 1 January 2027.',
          quotation,
          dateText: '1 January 2027',
        }),
      );

    const response = await extract(productId);
    const body = response.json().data;

    expect(response.statusCode).toBe(200);
    expect(body.claimsStored).toBe(1);
    expect(body.storedClaims[0]).toMatchObject({
      claimType: 'support_start',
      datePrecision: 'day',
      normalizedDate: '2027-01-01',
      reviewStatus: 'pending',
    });

    const rows = await evidenceRows(productId);
    expect(rows[0]).toMatchObject({
      date_precision: 'day',
      normalized_date: '2027-01-01',
      review_status: 'pending',
    });
  });

  it('extracts an os-version claim without inventing a date', async () => {
    const quotation = 'This product receives security updates while running Android 15.';
    const { productId } = await createProductWithSource({
      content: `Software support.\n\n${quotation}`,
    });

    fakeProvider.respond = () =>
      claimsResponse(
        claim({
          claimType: 'os_version',
          statement: 'Security updates are provided for Android 15.',
          quotation,
          dateText: null,
        }),
      );

    const body = (await extract(productId)).json().data;
    expect(body.claimsStored).toBe(1);
    expect(body.storedClaims[0]).toMatchObject({
      claimType: 'os_version',
      dateText: null,
      datePrecision: null,
      normalizedDate: null,
    });
  });

  it('extracts a policy claim that has no explicit date', async () => {
    const quotation =
      'Security updates are provided for a minimum of five years after product launch.';
    const { productId } = await createProductWithSource({
      content: `Lifecycle policy.\n\n${quotation}`,
    });

    fakeProvider.respond = () =>
      claimsResponse(
        claim({
          claimType: 'policy',
          statement: 'Security updates are provided for at least five years after launch.',
          quotation,
          dateText: null,
        }),
      );

    const body = (await extract(productId)).json().data;
    expect(body.claimsStored).toBe(1);
    expect(body.storedClaims[0]).toMatchObject({
      claimType: 'policy',
      dateText: null,
      datePrecision: null,
      normalizedDate: null,
    });
  });

  it('preserves month-only precision and leaves normalizedDate null', async () => {
    const quotation = 'Security support is committed until December 2030.';
    const { productId } = await createProductWithSource({ content: quotation });

    fakeProvider.respond = () =>
      claimsResponse(
        claim({
          claimType: 'support_end',
          quotation,
          dateText: 'December 2030',
        }),
      );

    const body = (await extract(productId)).json().data;
    expect(body.storedClaims[0]).toMatchObject({
      dateText: 'December 2030',
      datePrecision: 'month',
      normalizedDate: null,
    });
  });

  it('preserves year-only precision and leaves normalizedDate null', async () => {
    const quotation = 'Security updates continue through 2030.';
    const { productId } = await createProductWithSource({ content: quotation });

    fakeProvider.respond = () =>
      claimsResponse(
        claim({
          claimType: 'support_end',
          quotation,
          dateText: '2030',
        }),
      );

    const body = (await extract(productId)).json().data;
    expect(body.storedClaims[0]).toMatchObject({
      dateText: '2030',
      datePrecision: 'year',
      normalizedDate: null,
    });

    const rows = await evidenceRows(productId);
    expect(rows[0]).toMatchObject({ date_precision: 'year', normalized_date: null });
  });

  it('normalizes an explicitly stated full date', async () => {
    const quotation = 'Security updates end on 15 December 2030.';
    const { productId } = await createProductWithSource({ content: quotation });

    fakeProvider.respond = () =>
      claimsResponse(
        claim({
          claimType: 'support_end',
          quotation,
          dateText: '15 December 2030',
        }),
      );

    const body = (await extract(productId)).json().data;
    expect(body.storedClaims[0]).toMatchObject({
      dateText: '15 December 2030',
      datePrecision: 'day',
      normalizedDate: '2030-12-15',
    });
  });

  it('returns a successful zero-claim result when the page is irrelevant', async () => {
    const { productId } = await createProductWithSource({
      content: 'Welcome to our company. Read our latest marketing news.',
    });

    const response = await extract(productId);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      sourcesProcessed: 1,
      claimsExtracted: 0,
      claimsStored: 0,
      claimsRejected: 0,
      duplicateClaims: 0,
      extractionFailures: [],
    });
    expect(await evidenceRows(productId)).toHaveLength(0);
  });

  it('rejects a fabricated quotation that is absent from the source', async () => {
    const { productId } = await createProductWithSource({
      content: 'Security updates will be provided until December 2030.',
    });

    fakeProvider.respond = () =>
      claimsResponse(
        claim({
          claimType: 'support_end',
          statement: 'Security updates are provided until December 2031.',
          quotation: 'Security updates will be provided until December 2031.',
          dateText: 'December 2031',
        }),
      );

    const body = (await extract(productId)).json().data;
    expect(body).toMatchObject({ claimsExtracted: 1, claimsStored: 0, claimsRejected: 1 });
    expect(body.rejectedClaims[0]).toMatchObject({
      reason: 'quotation_not_found_in_source',
    });
    expect(await evidenceRows(productId)).toHaveLength(0);
  });

  it('rejects a support-end date that the quotation does not state', async () => {
    const { productId } = await createProductWithSource({
      content:
        'Security support is available for this device. December 2030 is the release window.',
    });

    fakeProvider.respond = () =>
      claimsResponse(
        claim({
          claimType: 'support_end',
          quotation: 'Security support is available for this device.',
          dateText: 'December 2030',
        }),
      );

    const body = (await extract(productId)).json().data;
    expect(body.claimsStored).toBe(0);
    expect(body.claimsRejected).toBe(1);
    expect(body.rejectedClaims[0]?.reason).toBe('date_text_not_in_quotation');
    expect(await evidenceRows(productId)).toHaveLength(0);
  });

  it('does not treat the latest patch date as a support-end date', async () => {
    const quotation = 'The latest security patch was released on 3 March 2026.';
    const { productId } = await createProductWithSource({ content: quotation });

    fakeProvider.respond = () =>
      claimsResponse(
        claim({
          claimType: 'support_end',
          quotation,
          dateText: '3 March 2026',
        }),
      );

    const body = (await extract(productId)).json().data;
    expect(body.claimsStored).toBe(0);
    expect(body.rejectedClaims[0]?.reason).toBe('latest_patch_date_not_support_end');
  });

  it('does not treat a warranty statement as security support', async () => {
    const quotation = 'This product comes with a two-year warranty until 15 December 2027.';
    const { productId } = await createProductWithSource({ content: quotation });

    fakeProvider.respond = () =>
      claimsResponse(
        claim({
          claimType: 'support_end',
          quotation,
          dateText: '15 December 2027',
        }),
      );

    const body = (await extract(productId)).json().data;
    expect(body.claimsStored).toBe(0);
    expect(body.rejectedClaims[0]?.reason).toBe('warranty_not_support_commitment');
  });

  it('skips third-party retailer sources and never calls the provider', async () => {
    const quotation = 'Security updates will be provided until December 2030.';
    const product = await createProduct();
    await addSource(product.id, {
      url: `https://${RETAILER_HOST}/product/widget`,
      domain: RETAILER_HOST,
      content: quotation,
      relationshipType: 'support_page',
    });

    fakeProvider.respond = () =>
      claimsResponse(claim({ claimType: 'support_end', quotation, dateText: 'December 2030' }));

    const body = (await extract(product.id)).json().data;
    expect(body.sourcesProcessed).toBe(0);
    expect(body.sourcesSkipped).toBe(1);
    expect(body.skippedSources[0]).toMatchObject({ reason: 'third_party_source' });
    expect(body.claimsStored).toBe(0);
    expect(fakeProvider.calls).toHaveLength(0);
    expect(await evidenceRows(product.id)).toHaveLength(0);
  });

  it('handles malformed AI JSON as a per-source extraction failure', async () => {
    const { productId } = await createProductWithSource({
      content: 'Security updates will be provided until December 2030.',
    });

    fakeProvider.respond = () => 'Sorry, I cannot return JSON.';

    const response = await extract(productId);
    expect(response.statusCode).toBe(200);

    const body = response.json().data;
    expect(body.claimsStored).toBe(0);
    expect(body.extractionFailures).toHaveLength(1);
    expect(body.extractionFailures[0]).toMatchObject({
      sourceId: expect.any(String),
      reason: 'malformed_ai_json',
    });
    expect(await evidenceRows(productId)).toHaveLength(0);
  });

  it('returns a clear 503 when AI is not configured', async () => {
    const product = await createProduct();

    const response = await extract(product.id, unconfiguredApp);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'AI_NOT_CONFIGURED' } });
  });

  it('returns 504 when the AI provider times out', async () => {
    const { productId } = await createProductWithSource({
      content: 'Security updates will be provided until December 2030.',
    });

    const response = await extract(productId, timeoutApp);
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ error: { code: 'AI_PROVIDER_TIMEOUT' } });
    expect(await evidenceRows(productId)).toHaveLength(0);
  });

  it('returns 502 when the AI provider fails', async () => {
    const { productId } = await createProductWithSource({
      content: 'Security updates will be provided until December 2030.',
    });

    const response = await extract(productId, providerErrorApp);
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: 'AI_PROVIDER_ERROR' } });
    expect(await evidenceRows(productId)).toHaveLength(0);
  });

  it('does not duplicate evidence when extraction is repeated', async () => {
    const quotation = 'Security updates will be provided until December 2030.';
    const { productId } = await createProductWithSource({ content: quotation });

    fakeProvider.respond = () =>
      claimsResponse(claim({ claimType: 'support_end', quotation, dateText: 'December 2030' }));

    const first = (await extract(productId)).json().data;
    expect(first.claimsStored).toBe(1);
    expect(first.duplicateClaims).toBe(0);

    const second = (await extract(productId)).json().data;
    expect(second.claimsStored).toBe(0);
    expect(second.duplicateClaims).toBe(1);
    expect(second.duplicates[0]).toMatchObject({
      existingEvidenceId: first.storedClaims[0].evidenceId,
      reason: 'duplicate_claim',
    });

    expect(await evidenceRows(productId)).toHaveLength(1);
  });

  it('never overwrites previously accepted evidence', async () => {
    const quotation = 'Security updates will be provided until December 2030.';
    const product = await createProduct();
    const sourceId = await addSource(product.id, { content: quotation });

    const [accepted] = await database.client`
      insert into evidence (
        product_id, source_id, claim_type, raw_text, quoted_excerpt,
        date_text, date_precision, normalized_date, confidence,
        extraction_method, review_status
      ) values (
        ${product.id}, ${sourceId}, 'support_end', 'Manually reviewed statement',
        ${quotation}, 'December 2030', 'month', null, 0.8,
        'manual', 'accepted'
      )
      returning id
    `;

    fakeProvider.respond = () =>
      claimsResponse(
        claim({
          claimType: 'support_end',
          statement: 'AI restatement that must not replace the reviewed row.',
          quotation,
          dateText: 'December 2030',
        }),
      );

    const body = (await extract(product.id)).json().data;
    expect(body.claimsStored).toBe(0);
    expect(body.duplicateClaims).toBe(1);
    expect(body.duplicates[0]?.existingEvidenceId).toBe(accepted?.id);

    const rows = await evidenceRows(product.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: accepted?.id,
      raw_text: 'Manually reviewed statement',
      extraction_method: 'manual',
      review_status: 'accepted',
    });
  });

  it('excludes discovered external candidates even when they have content', async () => {
    const quotation = 'Security updates will be provided until December 2030.';
    const product = await createProduct();
    await addSource(product.id, {
      content: quotation,
      relationshipType: 'discovered_candidate',
    });

    fakeProvider.respond = () =>
      claimsResponse(claim({ claimType: 'support_end', quotation, dateText: 'December 2030' }));

    const body = (await extract(product.id)).json().data;
    expect(body.sourcesProcessed).toBe(0);
    expect(body.skippedSources[0]).toMatchObject({ reason: 'discovered_candidate' });
    expect(fakeProvider.calls).toHaveLength(0);
    expect(await evidenceRows(product.id)).toHaveLength(0);
  });

  it('skips sources with empty content', async () => {
    const product = await createProduct();
    await addSource(product.id, { content: '   \n\t  ' });

    const response = await extract(product.id);
    const body = response.json().data;

    expect(response.statusCode).toBe(200);
    expect(body.sourcesProcessed).toBe(0);
    expect(body.skippedSources[0]).toMatchObject({ reason: 'empty_content' });
    expect(fakeProvider.calls).toHaveLength(0);
  });

  it('keeps all extracted evidence pending after extraction', async () => {
    const quotation = 'Security updates will be provided until December 2030.';
    const osQuotation = 'This product receives security updates while running Android 15.';
    const { productId } = await createProductWithSource({
      content: `${quotation}\n\n${osQuotation}`,
    });

    fakeProvider.respond = () =>
      claimsResponse(
        claim({ claimType: 'support_end', quotation, dateText: 'December 2030' }),
        claim({
          claimType: 'os_version',
          quotation: osQuotation,
          dateText: null,
        }),
      );

    const body = (await extract(productId)).json().data;
    expect(body.claimsStored).toBe(2);
    expect(body.storedClaims.every((stored: { reviewStatus: string }) => stored.reviewStatus === 'pending')).toBe(true);

    const rows = await evidenceRows(productId);
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row) => (row as { review_status: string }).review_status === 'pending',
      ),
    ).toBe(true);
  });

  it('processes no more than five sources per request', async () => {
    const product = await createProduct();
    const quotation = 'Security updates will be provided until December 2030.';
    for (let index = 0; index < 7; index += 1) {
      await addSource(product.id, {
        content: `${quotation} Source ${index}.`,
        relationshipType: 'support_page',
      });
    }

    fakeProvider.respond = () => claimsResponse();

    const body = (await extract(product.id)).json().data;
    expect(body.sourcesProcessed).toBe(5);
    expect(body.sourcesSkipped).toBe(2);
    expect(body.skippedSources.filter((source: { reason: string }) => source.reason === 'source_limit')).toHaveLength(2);
    expect(fakeProvider.calls).toHaveLength(5);
  });

  it('uses the configured OpenAI-compatible provider when none is injected', async () => {
    const quotation = 'Security updates will be provided until December 2030.';
    const { productId } = await createProductWithSource({ content: quotation });

    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            model: 'configured-model',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: claimsResponse(
                    claim({ claimType: 'support_end', quotation, dateText: 'December 2030' }),
                  ),
                },
              },
            ],
          }),
        );
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test AI server did not expose a port');
    }

    // `.env` may define SERV_* variables, which take precedence over AI_* when
    // the provider is built from the environment. Clear them for this test so it
    // exercises the generic OpenAI-compatible path deterministically instead of
    // calling a real SERV endpoint.
    const keys = [
      'AI_BASE_URL',
      'AI_API_KEY',
      'AI_MODEL',
      'SERV_API_KEY',
      'SERV_MODEL',
      'SERV_BASE_URL',
    ] as const;
    const saved = keys.map((key) => [key, process.env[key]] as const);

    for (const key of ['SERV_API_KEY', 'SERV_MODEL', 'SERV_BASE_URL'] as const) {
      delete process.env[key];
    }

    process.env.AI_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.AI_API_KEY = 'test-key';
    process.env.AI_MODEL = 'configured-model';

    let configuredApp: FastifyInstance | undefined;
    try {
      configuredApp = buildApp({ database, logger: false, auth: TEST_AUTH });
      await configuredApp.ready();
      await login(configuredApp);

      const response = await extract(productId, configuredApp);
      expect(response.statusCode).toBe(200);

      const body = response.json().data;
      expect(body.provider).toBe('openai-compatible:configured-model');
      expect(body.claimsStored).toBe(1);
      expect(body.storedClaims[0]).toMatchObject({
        claimType: 'support_end',
        datePrecision: 'month',
        normalizedDate: null,
        reviewStatus: 'pending',
      });
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await configuredApp?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
