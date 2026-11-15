import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { closeDatabase, createDatabase, type Database } from '../src/db/client.js';
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
} from '../src/extraction/provider.js';
import { AiProviderError } from '../src/extraction/provider.js';
import type { Fetcher, FetchResult } from '../src/research/fetcher.js';
import type { UrlValidator } from '../src/research/research-service.js';
import { authCookie, login, TEST_AUTH } from './helpers/test-auth.js';

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PREFIX = `Step9B1 Research ${RUN_ID}`;
const HOST = `research-${RUN_ID}.test`;
const BASE = `https://${HOST}`;
const QUOTATION = 'Security updates will be provided until December 2030.';

interface MockPage {
  status?: number;
  body?: string;
  contentType?: string;
}

class MockFetcher implements Fetcher {
  readonly pages = new Map<string, MockPage>();
  readonly requested: string[] = [];

  reset(): void {
    this.pages.clear();
    this.requested.length = 0;
  }

  async fetch(url: string): Promise<FetchResult> {
    this.requested.push(url);
    const parsed = new URL(url);
    if (parsed.pathname === '/robots.txt') {
      return this.result(url, 404, 'text/plain', 'not found');
    }

    const page = this.pages.get(url);
    if (!page) return this.result(url, 404, 'text/html', '<html><body>missing</body></html>');

    return this.result(
      url,
      page.status ?? 200,
      page.contentType ?? 'text/html; charset=utf-8',
      page.body ?? '',
    );
  }

  private result(url: string, status: number, contentType: string, body: string): FetchResult {
    return {
      url,
      finalUrl: url,
      status,
      contentType,
      body,
      bytes: Buffer.byteLength(body),
      fetchedAt: new Date(),
      redirects: 0,
    };
  }
}

class FakeProvider implements AiProvider {
  readonly name = 'workbench-test-provider';
  readonly calls: AiCompletionRequest[] = [];
  respond: () => string | Promise<string> = () => JSON.stringify({ claims: [] });

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    this.calls.push(request);
    return { text: await this.respond(), model: 'workbench-test-model' };
  }

  reset(): void {
    this.calls.length = 0;
    this.respond = () => JSON.stringify({ claims: [] });
  }
}

function htmlPage(options: {
  title: string;
  text?: string;
  links?: Array<[string, string]>;
}): string {
  const links = (options.links ?? [])
    .map(([href, label]) => `<a href="${href}">${label}</a>`)
    .join('');
  return `<!doctype html><html><head><title>${options.title}</title></head><body>
    <main><h1>${options.title}</h1><p>${options.text ?? 'Manufacturer support information.'}</p>${links}</main>
    <script>neverDisplayThisScript()</script>
  </body></html>`;
}

function claimResponse(
  quotation: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    claims: [
      {
        claimType: 'support_end',
        statement: 'Security updates are provided until December 2030.',
        quotation,
        dateText: 'December 2030',
        confidence: 0.97,
        explanation: 'The manufacturer states the end date directly.',
        ...overrides,
      },
    ],
  });
}

let app: FastifyInstance;
let unconfiguredApp: FastifyInstance;
let timeoutApp: FastifyInstance;
let providerErrorApp: FastifyInstance;
let shortSessionApp: FastifyInstance;
let database: Database;
let fetcher: MockFetcher;
let provider: FakeProvider;
let manufacturerId: string;
let noWebsiteManufacturerId: string;
let fetchedSourceId: string;
let candidateSourceId: string;
let countedProductId: string;
let emptyProductId: string;
let noWebsiteProductId: string;
let sequence = 0;

const stubValidateUrl: UrlValidator = async (value) => {
  const url = new URL(value);
  return { url, hostname: url.hostname };
};

function request(
  method: 'GET' | 'POST',
  url: string,
  target: FastifyInstance = app,
  payload?: unknown,
) {
  return target.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
    headers: { cookie: authCookie(target) },
  });
}

function post(url: string, payload?: unknown, target: FastifyInstance = app) {
  return request('POST', url, target, payload);
}

async function createManufacturer(name: string, website?: string): Promise<string> {
  const response = await post('/api/v1/manufacturers', {
    name: `${TEST_PREFIX} ${name}`,
    ...(website ? { website } : {}),
  });
  expect(response.statusCode).toBe(201);
  return response.json().data.id as string;
}

async function createProduct(
  makerId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  sequence += 1;
  const response = await post('/api/v1/products', {
    manufacturerId: makerId,
    name: `${TEST_PREFIX} Product ${sequence}`,
    modelIdentifier: `S9B1-${RUN_ID}-${sequence}`,
    ...overrides,
  });
  expect(response.statusCode).toBe(201);
  return response.json().data.id as string;
}

async function addSource(
  productId: string,
  options: {
    url: string;
    domain: string;
    relationshipType: string;
    title?: string;
    content?: string | null;
    httpStatus?: number | null;
  },
): Promise<string> {
  const fetched = options.httpStatus !== null && options.httpStatus !== undefined;
  const [source] = await database.client`
    insert into sources (
      url, domain, title, description, content_text, http_status, content_hash, fetched_at
    ) values (
      ${options.url}, ${options.domain}, ${options.title ?? 'Source page'},
      'Stored source description', ${options.content ?? null}, ${options.httpStatus ?? null},
      ${fetched ? 'stored-content-hash' : null}, ${fetched ? new Date().toISOString() : null}
    )
    on conflict (url) do update set
      title = excluded.title,
      content_text = excluded.content_text,
      http_status = excluded.http_status,
      fetched_at = excluded.fetched_at
    returning id
  `;

  const sourceId = source?.id as string;
  await database.client`
    insert into product_sources (product_id, source_id, relationship_type)
    values (${productId}, ${sourceId}, ${options.relationshipType})
    on conflict do nothing
  `;
  return sourceId;
}

beforeAll(async () => {
  loadEnv();
  database = createDatabase(loadEnv().DATABASE_URL);
  await migrate(database.orm, { migrationsFolder: 'drizzle' });

  fetcher = new MockFetcher();
  provider = new FakeProvider();

  app = buildApp({
    database,
    logger: false,
    auth: TEST_AUTH,
    research: { fetcher, validateUrl: stubValidateUrl },
    extraction: { provider },
  });
  await app.ready();
  await login(app);

  unconfiguredApp = buildApp({
    database,
    logger: false,
    auth: TEST_AUTH,
    research: { fetcher, validateUrl: stubValidateUrl },
    extraction: { provider: null },
  });
  await unconfiguredApp.ready();
  await login(unconfiguredApp);

  timeoutApp = buildApp({
    database,
    logger: false,
    auth: TEST_AUTH,
    research: { fetcher, validateUrl: stubValidateUrl },
    extraction: {
      provider: {
        name: 'timeout-provider',
        async complete() {
          throw new AiProviderError('TIMEOUT', 'provider timed out');
        },
      },
    },
  });
  await timeoutApp.ready();
  await login(timeoutApp);

  providerErrorApp = buildApp({
    database,
    logger: false,
    auth: TEST_AUTH,
    research: { fetcher, validateUrl: stubValidateUrl },
    extraction: {
      provider: {
        name: 'error-provider',
        async complete() {
          throw new AiProviderError('HTTP_ERROR', 'provider failed');
        },
      },
    },
  });
  await providerErrorApp.ready();
  await login(providerErrorApp);

  shortSessionApp = buildApp({
    database,
    logger: false,
    auth: { ...TEST_AUTH, sessionTtlMs: 40 },
  });
  await shortSessionApp.ready();

  manufacturerId = await createManufacturer('Maker', BASE);
  noWebsiteManufacturerId = await createManufacturer('No Website');

  countedProductId = await createProduct(manufacturerId, {
    name: `${TEST_PREFIX} Counted product`,
    category: 'Network appliance',
  });
  emptyProductId = await createProduct(manufacturerId, {
    name: `${TEST_PREFIX} Empty research product`,
  });
  noWebsiteProductId = await createProduct(noWebsiteManufacturerId, {
    name: `${TEST_PREFIX} Missing website product`,
  });

  fetchedSourceId = await addSource(countedProductId, {
    url: `${BASE}/support/security`,
    domain: HOST,
    relationshipType: 'support_page',
    title: 'Security support',
    content: `Stored source body with a secret marker. ${QUOTATION}`,
    httpStatus: 200,
  });
  await database.client`
    insert into product_sources (product_id, source_id, relationship_type)
    values (${countedProductId}, ${fetchedSourceId}, 'policy_page')
    on conflict do nothing
  `;

  candidateSourceId = await addSource(countedProductId, {
    url: `https://docs.${HOST}/manual`,
    domain: `docs.${HOST}`,
    relationshipType: 'discovered_candidate',
    title: 'External documentation',
    content: null,
    httpStatus: null,
  });

  await database.client`
    insert into evidence (
      product_id, source_id, claim_type, raw_text, quoted_excerpt,
      date_text, date_precision, normalized_date, confidence,
      explanation, extraction_method, review_status
    ) values (
      ${countedProductId}, ${fetchedSourceId}, 'support_end',
      'Security updates are provided until December 2030.',
      ${QUOTATION}, 'December 2030', 'month', null, 0.9,
      'Stored pending fixture.', 'manual', 'pending'
    )
  `;
});

beforeEach(() => {
  fetcher.reset();
  provider.reset();
});

afterAll(async () => {
  if (database) {
    await database.client`
      delete from products
      where manufacturer_id in (
        select id from manufacturers where normalized_name like ${`${TEST_PREFIX.toLowerCase()}%`}
      )
    `;
    await database.client`
      delete from manufacturers where normalized_name like ${`${TEST_PREFIX.toLowerCase()}%`}
    `;
    await database.client`delete from sources where url like ${`%${RUN_ID}%`}`;
  }

  await Promise.all([
    app?.close(),
    unconfiguredApp?.close(),
    timeoutApp?.close(),
    providerErrorApp?.close(),
    shortSessionApp?.close(),
  ]);
  if (database) await closeDatabase(database);
});

describe('research workbench authentication and shell', () => {
  it('requires authentication for the research page, product list and source API', async () => {
    const page = await app.inject({ method: 'GET', url: '/dashboard/research' });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe(
      `/login?next=${encodeURIComponent('/dashboard/research')}`,
    );

    for (const url of [
      '/api/v1/dashboard/research/products',
      `/api/v1/products/${countedProductId}/sources`,
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
    }
  });

  it('serves the research shell with the Research navigation item when signed in', async () => {
    const response = await request('GET', '/dashboard/research');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('id="view"');
    expect(response.body).toContain('data-nav="research"');
    expect(response.body).toContain('href="/dashboard/research"');
  });

  it('rejects an expired session on the research page and API', async () => {
    await login(shortSessionApp);
    await new Promise((resolve) => setTimeout(resolve, 90));

    const page = await shortSessionApp.inject({
      method: 'GET',
      url: '/dashboard/research',
    });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toContain('/login?next=');

    const api = await shortSessionApp.inject({
      method: 'GET',
      url: '/api/v1/dashboard/research/products',
    });
    expect(api.statusCode).toBe(401);
  });
});

describe('research product selection and persisted sources', () => {
  it('loads actual products with pagination and stored source/evidence counts', async () => {
    const pageOne = await request(
      'GET',
      `/api/v1/dashboard/research/products?manufacturerId=${manufacturerId}&page=1&pageSize=1`,
    );
    expect(pageOne.statusCode).toBe(200);
    const body = pageOne.json();
    expect(body.pagination).toMatchObject({ page: 1, pageSize: 1, total: 2, totalPages: 2 });
    expect(body.data).toHaveLength(1);

    const all = await request(
      'GET',
      `/api/v1/dashboard/research/products?manufacturerId=${manufacturerId}&page=1&pageSize=20`,
    );
    expect(all.statusCode).toBe(200);
    const products = all.json().data as Array<{
      id: string;
      manufacturer: { website: string | null };
      research: {
        status: string;
        sourceCount: number;
        fetchedSourceCount: number;
        candidateCount: number;
        evidenceCount: number;
        lastActivityAt: string | null;
      };
    }>;

    const counted = products.find((product) => product.id === countedProductId);
    expect(counted).toMatchObject({
      manufacturer: { website: BASE },
      research: {
        status: 'sources_fetched',
        sourceCount: 2,
        fetchedSourceCount: 1,
        candidateCount: 1,
        evidenceCount: 1,
      },
    });
    expect(counted?.research.lastActivityAt).toEqual(expect.any(String));

    const empty = products.find((product) => product.id === emptyProductId);
    expect(empty).toMatchObject({
      research: {
        status: 'not_researched',
        sourceCount: 0,
        fetchedSourceCount: 0,
        candidateCount: 0,
        evidenceCount: 0,
        lastActivityAt: null,
      },
    });
  });

  it('reports a missing manufacturer website and rejects research with a clear 422', async () => {
    const body = (
      await request(
        'GET',
        `/api/v1/dashboard/research/products?manufacturerId=${noWebsiteManufacturerId}&pageSize=20`,
      )
    ).json();
    expect(body.pagination.total).toBe(1);
    expect(body.data[0]).toMatchObject({
      id: noWebsiteProductId,
      manufacturer: { website: null },
      research: { status: 'not_researched' },
    });

    const response = await post(`/api/v1/products/${noWebsiteProductId}/research`);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: 'MANUFACTURER_WEBSITE_MISSING' },
    });
  });

  it('returns safe persisted source metadata, role types and candidate distinction', async () => {
    const response = await request('GET', `/api/v1/products/${countedProductId}/sources`);
    expect(response.statusCode).toBe(200);

    const sources = response.json().data as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(2);

    const fetched = sources.find((source) => source.id === fetchedSourceId);
    expect(fetched).toMatchObject({
      title: 'Security support',
      domain: HOST,
      httpStatus: 200,
      isFetched: true,
      isExternalCandidate: false,
      hasContent: true,
    });
    expect(fetched?.relationshipTypes).toEqual(
      expect.arrayContaining(['support_page', 'policy_page']),
    );
    expect(fetched?.lastFetchedAt).toEqual(expect.any(String));

    const candidate = sources.find((source) => source.id === candidateSourceId);
    expect(candidate).toMatchObject({
      domain: `docs.${HOST}`,
      httpStatus: null,
      lastFetchedAt: null,
      isFetched: false,
      isExternalCandidate: true,
      relationshipTypes: ['discovered_candidate'],
    });

    // The workbench must never receive full stored page text or content hashes.
    const serialized = JSON.stringify(response.json());
    expect(serialized).not.toContain('secret marker');
    expect(fetched).not.toHaveProperty('contentText');
    expect(fetched).not.toHaveProperty('contentHash');
  });

  it('returns 404 for sources of an unknown product', async () => {
    const response = await request(
      'GET',
      '/api/v1/products/00000000-0000-4000-8000-000000000000/sources',
    );
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'PRODUCT_NOT_FOUND' } });
  });
});

describe('research execution and extraction', () => {
  it('runs research synchronously, reports failures and distinguishes unvisited candidates', async () => {
    fetcher.pages.set(`${BASE}/`, {
      body: htmlPage({
        title: 'Workbench Manufacturer',
        text: `Homepage support text. ${QUOTATION}`,
        links: [
          [`${BASE}/support/security`, 'Security Advisories'],
          [`${BASE}/support/updates`, 'Software Updates'],
          [`${BASE}/support/missing`, 'Support Downloads'],
          [`https://docs.${HOST}/manual`, 'Documentation'],
        ],
      }),
    });
    fetcher.pages.set(`${BASE}/support/security`, {
      body: htmlPage({ title: 'Security Advisories', text: 'Advisory list.' }),
    });
    fetcher.pages.set(`${BASE}/support/updates`, {
      body: htmlPage({ title: 'Software Updates', text: 'Firmware downloads.' }),
    });

    const productId = await createProduct(manufacturerId, {
      name: `${TEST_PREFIX} Research run`,
      productUrl: `${BASE}/products/example`,
    });
    fetcher.pages.set(`${BASE}/products/example`, {
      body: htmlPage({ title: 'Example product', text: 'Product support text.' }),
    });

    const response = await post(`/api/v1/products/${productId}/research`);
    expect(response.statusCode).toBe(200);

    const result = response.json().data;
    expect(result).toMatchObject({
      productId,
      pagesFetched: 4,
      manufacturer: { id: manufacturerId, website: BASE },
    });
    expect(result.researchedAt).toEqual(expect.any(String));
    expect(result.pagesDiscovered).toBeGreaterThanOrEqual(4);
    expect(result.failures).toContainEqual(
      expect.objectContaining({
        url: `${BASE}/support/missing`,
        reason: 'http_error',
        statusCode: 404,
      }),
    );
    expect(result.externalCandidates).toContainEqual(
      expect.objectContaining({
        url: `https://docs.${HOST}/manual`,
        reason: 'external_domain',
      }),
    );

    const fetchedUrls = result.sources.map((source: { url: string }) => source.url);
    expect(fetchedUrls).toContain(`${BASE}/`);
    expect(fetchedUrls).not.toContain('https://docs.${HOST}/manual');
    expect(fetcher.requested).not.toContain('https://docs.${HOST}/manual');

    const persisted = await request('GET', `/api/v1/products/${productId}/sources`);
    expect(persisted.statusCode).toBe(200);
    const sources = persisted.json().data as Array<{
      url: string;
      isFetched: boolean;
      isExternalCandidate: boolean;
    }>;
    expect(sources.some((source) => source.url === `${BASE}/` && source.isFetched)).toBe(true);
    expect(
      sources.some(
        (source) =>
          source.url === `https://docs.${HOST}/manual` &&
          source.isExternalCandidate &&
          !source.isFetched,
      ),
    ).toBe(true);

    const list = (
      await request(
        'GET',
        `/api/v1/dashboard/research/products?manufacturerId=${manufacturerId}&pageSize=100`,
      )
    ).json();
    const listed = list.data.find((item: { id: string }) => item.id === productId);
    expect(listed.research).toMatchObject({
      status: 'sources_fetched',
      fetchedSourceCount: 4,
    });
  });

  it('repeats research without duplicating records and marks unchanged sources', async () => {
    fetcher.pages.set(`${BASE}/`, {
      body: htmlPage({
        title: 'Repeatable Research',
        text: 'Stable source content.',
        links: [[`${BASE}/support/stable`, 'Software Updates']],
      }),
    });
    fetcher.pages.set(`${BASE}/support/stable`, {
      body: htmlPage({ title: 'Stable Updates', text: 'Stable update text.' }),
    });

    const productId = await createProduct(manufacturerId, {
      name: `${TEST_PREFIX} Repeat product`,
    });

    const first = await post(`/api/v1/products/${productId}/research`);
    expect(first.statusCode).toBe(200);
    const firstSources = first.json().data.sources as Array<{ id: string }>;

    const second = await post(`/api/v1/products/${productId}/research`);
    expect(second.statusCode).toBe(200);
    const secondBody = second.json().data;
    expect(
      secondBody.sources.every((source: { unchanged: boolean }) => source.unchanged),
    ).toBe(true);
    expect(secondBody.sources.map((source: { id: string }) => source.id)).toEqual(
      firstSources.map((source) => source.id),
    );

    const sources = (await request('GET', `/api/v1/products/${productId}/sources`)).json()
      .data as Array<{ url: string }>;
    expect(sources.filter((source) => source.url === `${BASE}/`)).toHaveLength(1);
  });

  it('extracts a support claim with quotation, date provenance and pending review', async () => {
    fetcher.pages.set(`${BASE}/`, {
      body: htmlPage({
        title: 'Extraction Manufacturer',
        text: `Support statement. ${QUOTATION}`,
        links: [[`${BASE}/support/security`, 'Security Advisories']],
      }),
    });
    fetcher.pages.set(`${BASE}/support/security`, {
      body: htmlPage({ title: 'Security Advisories', text: 'Other support text.' }),
    });

    const productId = await createProduct(manufacturerId, {
      name: `${TEST_PREFIX} Extraction product`,
    });
    const researchResponse = await post(`/api/v1/products/${productId}/research`);
    expect(researchResponse.statusCode).toBe(200);

    provider.respond = () => claimResponse(QUOTATION);

    const response = await post(`/api/v1/products/${productId}/extract-evidence`);
    expect(response.statusCode).toBe(200);
    const result = response.json().data;
    expect(result).toMatchObject({
      productId,
      sourcesProcessed: 2,
      claimsExtracted: 2,
      claimsStored: 1,
      claimsRejected: 1,
    });
    expect(result.storedClaims[0]).toMatchObject({
      claimType: 'support_end',
      statement: 'Security updates are provided until December 2030.',
      quotation: QUOTATION,
      dateText: 'December 2030',
      datePrecision: 'month',
      normalizedDate: null,
      reviewStatus: 'pending',
    });

    const evidenceResponse = await request(
      'GET',
      `/api/v1/products/${productId}/evidence?page=1&pageSize=50`,
    );
    expect(evidenceResponse.statusCode).toBe(200);
    const evidenceBody = evidenceResponse.json();
    expect(evidenceBody.pagination.total).toBe(1);
    expect(evidenceBody.data[0]).toMatchObject({
      claimType: 'support_end',
      rawText: 'Security updates are provided until December 2030.',
      quotedExcerpt: QUOTATION,
      reviewStatus: 'pending',
      source: { url: `${BASE}/`, domain: HOST },
    });
    expect(JSON.stringify(evidenceBody)).not.toContain('neverDisplayThisScript');
  });

  it('reports a successful zero-claim extraction without inventing evidence', async () => {
    const productId = await createProduct(manufacturerId, {
      name: `${TEST_PREFIX} No claims product`,
    });
    await addSource(productId, {
      url: `${BASE}/support/no-claims-${RUN_ID}`,
      domain: HOST,
      relationshipType: 'support_page',
      content: 'A marketing page with no support commitments.',
      httpStatus: 200,
    });

    provider.respond = () => JSON.stringify({ claims: [] });
    const response = await post(`/api/v1/products/${productId}/extract-evidence`);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      sourcesProcessed: 1,
      claimsExtracted: 0,
      claimsStored: 0,
      claimsRejected: 0,
      duplicateClaims: 0,
    });

    const evidence = await request(
      'GET',
      `/api/v1/products/${productId}/evidence?page=1&pageSize=50`,
    );
    expect(evidence.json().pagination.total).toBe(0);
  });

  it('returns clear AI configuration and provider failure responses', async () => {
    const notConfigured = await post(
      `/api/v1/products/${countedProductId}/extract-evidence`,
      undefined,
      unconfiguredApp,
    );
    expect(notConfigured.statusCode).toBe(503);
    expect(notConfigured.json()).toMatchObject({ error: { code: 'AI_NOT_CONFIGURED' } });

    const timeout = await post(
      `/api/v1/products/${countedProductId}/extract-evidence`,
      undefined,
      timeoutApp,
    );
    expect(timeout.statusCode).toBe(504);
    expect(timeout.json()).toMatchObject({ error: { code: 'AI_PROVIDER_TIMEOUT' } });

    const providerError = await post(
      `/api/v1/products/${countedProductId}/extract-evidence`,
      undefined,
      providerErrorApp,
    );
    expect(providerError.statusCode).toBe(502);
    expect(providerError.json()).toMatchObject({ error: { code: 'AI_PROVIDER_ERROR' } });
  });
});

describe('existing dashboard functionality', () => {
  it('keeps the authenticated dashboard summary and catalogue reachable', async () => {
    const summary = await request('GET', '/api/v1/dashboard/summary');
    expect(summary.statusCode).toBe(200);
    expect(summary.json().data).toHaveProperty('products.total');
    expect(summary.json().data).toHaveProperty('evidence.pendingReview');

    const catalogue = await request('GET', '/dashboard/products');
    expect(catalogue.statusCode).toBe(200);
    expect(catalogue.body).toContain('id="view"');

    const existingNav = await request('GET', '/dashboard/research');
    expect(existingNav.body).toContain('data-nav="products"');
    expect(existingNav.body).toContain('data-nav="import"');
    expect(existingNav.body).toContain('data-nav="overview"');
  });
});
