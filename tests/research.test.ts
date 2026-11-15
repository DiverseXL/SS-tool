import { createHash } from 'node:crypto';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { closeDatabase, createDatabase, type Database } from '../src/db/client.js';
import { FetchError, type FetchResult, type Fetcher } from '../src/research/fetcher.js';
import type { UrlValidator } from '../src/research/research-service.js';
import { authCookie, login, TEST_AUTH } from './helpers/test-auth.js';

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PREFIX = `Step4 Test ${RUN_ID}`;
const HOST = `acme-${RUN_ID}.test`;
const BASE = `https://${HOST}`;

interface MockPage {
  status?: number;
  body?: string;
  contentType?: string;
  error?: Error;
}

class MockFetcher implements Fetcher {
  readonly pages = new Map<string, MockPage>();
  readonly robots = new Map<string, string>();
  requests: string[] = [];

  reset(): void {
    this.pages.clear();
    this.robots.clear();
    this.requests = [];
  }

  async fetch(url: string): Promise<FetchResult> {
    this.requests.push(url);
    const parsed = new URL(url);

    if (parsed.pathname === '/robots.txt') {
      const rules = this.robots.get(parsed.origin);
      if (rules === undefined) return this.result(url, 404, 'text/plain', 'not found');
      return this.result(url, 200, 'text/plain', rules);
    }

    const page = this.pages.get(url);
    if (!page) return this.result(url, 404, 'text/html', '<html><body>missing</body></html>');
    if (page.error) throw page.error;

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

interface PageOptions {
  title: string;
  description?: string;
  canonical?: string;
  h1?: string;
  h2?: string[];
  text?: string;
  links?: Array<[string, string]>;
}

function htmlPage(options: PageOptions): string {
  const head = [
    `<title>${options.title}</title>`,
    options.description ? `<meta name="description" content="${options.description}">` : '',
    options.canonical ? `<link rel="canonical" href="${options.canonical}">` : '',
  ].join('');

  const headings = (options.h2 ?? []).map((heading) => `<h2>${heading}</h2>`).join('');
  const links = (options.links ?? [])
    .map(([href, text]) => `<a href="${href}">${text}</a>`)
    .join('');

  return `<!doctype html><html><head>${head}</head><body>
    <nav>NavOnly navigation</nav>
    <main>
      <h1>${options.h1 ?? options.title}</h1>
      ${headings}
      <p>${options.text ?? 'Main readable article text.'}</p>
      ${links}
    </main>
    <script>scriptOnlySecret()</script>
    <footer>FooterOnly</footer>
  </body></html>`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

let app: FastifyInstance;
let unsafeApp: FastifyInstance;
let database: Database;
let fetcher: MockFetcher;
let manufacturerId: string;
let modelCounter = 0;

const stubValidateUrl: UrlValidator = async (value) => {
  const url = new URL(value);
  return { url, hostname: url.hostname };
};

function post(url: string, payload?: unknown, target: FastifyInstance = app) {
  return target.inject({
    method: 'POST',
    url,
    payload: payload as object | undefined,
    headers: { cookie: authCookie(target) },
  });
}

async function createManufacturer(website: string | undefined, label: string): Promise<string> {
  const response = await post('/api/v1/manufacturers', {
    name: `${TEST_PREFIX} ${label}`,
    ...(website ? { website } : {}),
  });
  expect(response.statusCode).toBe(201);
  return response.json().data.id;
}

async function createProduct(overrides: Record<string, unknown> = {}) {
  modelCounter += 1;
  const response = await post('/api/v1/products', {
    manufacturerId,
    name: `${TEST_PREFIX} Product ${modelCounter}`,
    modelIdentifier: `S4-${RUN_ID}-${modelCounter}`,
    ...overrides,
  });
  expect(response.statusCode).toBe(201);
  return response.json().data as { id: string; productUrl: string | null };
}

function research(productId: string, target: FastifyInstance = app) {
  return target.inject({
    method: 'POST',
    url: `/api/v1/products/${productId}/research`,
    headers: { cookie: authCookie(target) },
  });
}

beforeAll(async () => {
  loadEnv();
  database = createDatabase(loadEnv().DATABASE_URL);
  await migrate(database.orm, { migrationsFolder: 'drizzle' });

  fetcher = new MockFetcher();
  app = buildApp({
    database,
    logger: false,
    auth: TEST_AUTH,
    research: { fetcher, validateUrl: stubValidateUrl },
  });
  await app.ready();
  await login(app);

  // Uses the production URL validator, which blocks literal private addresses
  // without requiring DNS.
  unsafeApp = buildApp({ database, logger: false, auth: TEST_AUTH, research: { fetcher } });
  await unsafeApp.ready();
  await login(unsafeApp);

  manufacturerId = await createManufacturer(BASE, 'Maker');
});

beforeEach(() => {
  fetcher.reset();
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
  await unsafeApp?.close();
  if (database) await closeDatabase(database);
});

describe('POST /api/v1/products/:id/research', () => {
  it('validates the product id and returns 404 for an unknown product', async () => {
    const malformed = await research('not-a-uuid');
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const unknown = await research('00000000-0000-4000-8000-000000000000');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { code: 'PRODUCT_NOT_FOUND' } });
  });

  it('explains that research cannot start without a manufacturer website', async () => {
    const noWebsiteManufacturer = await createManufacturer(undefined, 'No Website');
    const productResponse = await post('/api/v1/products', {
      manufacturerId: noWebsiteManufacturer,
      name: `${TEST_PREFIX} No Website Product`,
    });
    const productId = productResponse.json().data.id;

    const response = await research(productId);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: 'MANUFACTURER_WEBSITE_MISSING' },
    });
    expect(fetcher.requests).toHaveLength(0);
  });

  it('blocks a manufacturer website on localhost or a private address', async () => {
    const localhostManufacturer = await createManufacturer('http://127.0.0.1', 'Localhost');
    const localhostProduct = await post('/api/v1/products', {
      manufacturerId: localhostManufacturer,
      name: `${TEST_PREFIX} Localhost Product`,
    });

    const response = await research(localhostProduct.json().data.id, unsafeApp);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: 'UNSAFE_MANUFACTURER_WEBSITE' },
    });
    expect(fetcher.requests).toHaveLength(0);
  });

  it('fetches the homepage and product page, discovers support pages and stores metadata', async () => {
    const homepageBody = htmlPage({
      title: 'Acme Support Centre',
      description: 'Support, updates and security information for Acme products.',
      canonical: `${BASE}/`,
      h1: 'Acme Support',
      h2: ['Security advisories', 'Our products'],
      text: 'This is the main readable article text for Acme support.',
      links: [
        [`${BASE}/support/security-advisories`, 'Security Advisories'],
        [`${BASE}/support/software-updates`, 'Software and Firmware Updates'],
        [`${BASE}/support/end-of-life`, 'End of Life Policy'],
        [`${BASE}/support/security-advisories`, 'Security Advisories duplicate'],
        [`${BASE}/about/careers`, 'Careers'],
        [`${BASE}/privacy`, 'Privacy Policy'],
        [`https://support.${HOST}/faq`, 'Support Portal'],
        ['https://retailer.example/buy', 'Buy now'],
      ],
    });

    fetcher.pages.set(`${BASE}/`, { body: homepageBody });
    fetcher.pages.set(`${BASE}/products/widget-100`, {
      body: htmlPage({ title: 'Widget 100', h1: 'Widget 100', text: 'Product page text.' }),
    });
    fetcher.pages.set(`${BASE}/support/security-advisories`, {
      body: htmlPage({
        title: 'Security Advisories',
        description: 'Security bulletins for Acme products.',
        text: 'Advisory list.',
      }),
    });
    fetcher.pages.set(`${BASE}/support/software-updates`, {
      body: htmlPage({ title: 'Software Updates', text: 'Firmware downloads.' }),
    });
    fetcher.pages.set(`${BASE}/support/end-of-life`, {
      body: htmlPage({ title: 'End of Life Policy', text: 'Lifecycle policy.' }),
    });

    const product = await createProduct({
      name: `${TEST_PREFIX} Widget 100`,
      productUrl: `${BASE}/products/widget-100`,
    });

    const response = await research(product.id);
    expect(response.statusCode).toBe(200);

    const body = response.json().data;
    expect(body).toMatchObject({
      productId: product.id,
      pagesFetched: 5,
      pagesDiscovered: expect.any(Number),
      limits: { maxPages: 5, maxDiscoveryDepth: 1, maxBytes: 2097152, timeoutMs: 10000 },
      manufacturer: { id: manufacturerId, website: BASE },
    });

    const relationshipTypes = body.sources.map(
      (source: { relationshipType: string }) => source.relationshipType,
    );
    expect(relationshipTypes).toEqual(
      expect.arrayContaining([
        'manufacturer_homepage',
        'product_page',
        'security_advisory',
        'support_page',
        'policy_page',
      ]),
    );

    const homepage = body.sources.find(
      (source: { relationshipType: string }) => source.relationshipType === 'manufacturer_homepage',
    );
    expect(homepage).toMatchObject({
      url: `${BASE}/`,
      title: 'Acme Support Centre',
      description: 'Support, updates and security information for Acme products.',
      canonicalUrl: `${BASE}/`,
      httpStatus: 200,
      contentHash: sha256(homepageBody),
      unchanged: false,
    });
    expect(homepage.fetchedAt).toEqual(expect.any(String));
    expect(body.storedSourceIds).toContain(homepage.id);

    // Navigation, scripts and footer text must not leak into stored content.
    const [stored] = await database.client`
      select content_text from sources where id = ${homepage.id}
    `;
    expect(stored?.content_text).toContain('This is the main readable article text');
    expect(stored?.content_text).not.toContain('NavOnly');
    expect(stored?.content_text).not.toContain('scriptOnlySecret');
    expect(stored?.content_text).not.toContain('FooterOnly');

    // Irrelevant navigation and commerce links are never fetched.
    expect(fetcher.requests).not.toContain(`${BASE}/about/careers`);
    expect(fetcher.requests).not.toContain(`${BASE}/privacy`);
    expect(fetcher.requests).not.toContain('https://retailer.example/buy');

    // External support links are recorded but not requested.
    const external = body.externalCandidates.find(
      (candidate: { url: string }) => candidate.url === `https://support.${HOST}/faq`,
    );
    expect(external).toMatchObject({ reason: 'external_domain' });
    expect(external.sourceId).toEqual(expect.any(String));
    expect(fetcher.requests).not.toContain(`https://support.${HOST}/faq`);

    const [externalSource] = await database.client`
      select http_status, fetched_at, domain from sources where id = ${external.sourceId}
    `;
    expect(externalSource).toMatchObject({
      http_status: null,
      fetched_at: null,
      domain: `support.${HOST}`,
    });

    // Associations exist for every fetched page plus the external candidate.
    const [association] = await database.client`
      select count(*)::int as count from product_sources
      where product_id = ${product.id}
    `;
    expect(association?.count).toBe(6);
  });

  it('does not duplicate sources or associations when research is repeated', async () => {
    const homepageBody = htmlPage({
      title: 'Repeat Homepage',
      text: 'Repeatable content.',
      links: [[`${BASE}/support/updates`, 'Software Updates']],
    });
    fetcher.pages.set(`${BASE}/`, { body: homepageBody });
    fetcher.pages.set(`${BASE}/support/updates`, {
      body: htmlPage({ title: 'Updates', text: 'Update text.' }),
    });

    const product = await createProduct();

    const first = await research(product.id);
    expect(first.statusCode).toBe(200);
    expect(first.json().data.pagesFetched).toBe(2);

    const [beforeCounts] = await database.client`
      select
        (select count(*)::int from sources where url like ${`%${RUN_ID}%`}) as sources,
        (select count(*)::int from product_sources where product_id = ${product.id}) as associations
    `;

    const second = await research(product.id);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.pagesFetched).toBe(2);
    expect(
      second.json().data.sources.every((source: { unchanged: boolean }) => source.unchanged),
    ).toBe(true);

    const [afterCounts] = await database.client`
      select
        (select count(*)::int from sources where url like ${`%${RUN_ID}%`}) as sources,
        (select count(*)::int from product_sources where product_id = ${product.id}) as associations
    `;
    expect(afterCounts).toEqual(beforeCounts);
  });

  it('records HTTP errors and continues with other pages', async () => {
    fetcher.pages.set(`${BASE}/`, {
      body: htmlPage({
        title: 'Error Homepage',
        links: [
          [`${BASE}/support/security`, 'Security Advisories'],
          [`${BASE}/support/updates`, 'Software Updates'],
        ],
      }),
    });
    fetcher.pages.set(`${BASE}/support/security`, { status: 500, body: 'server error' });
    fetcher.pages.set(`${BASE}/support/updates`, {
      body: htmlPage({ title: 'Updates', text: 'Updates text.' }),
    });

    const product = await createProduct();
    const response = await research(product.id);
    const body = response.json().data;

    expect(response.statusCode).toBe(200);
    expect(body.failures).toContainEqual(
      expect.objectContaining({
        url: `${BASE}/support/security`,
        reason: 'http_error',
        statusCode: 500,
      }),
    );
    expect(body.pagesFetched).toBe(2);
    expect(body.sources.map((source: { url: string }) => source.url)).not.toContain(
      `${BASE}/support/security`,
    );
  });

  it('respects robots.txt and reports disallowed pages without fetching them', async () => {
    fetcher.robots.set(BASE, 'User-agent: *\nDisallow: /support/security');
    fetcher.pages.set(`${BASE}/`, {
      body: htmlPage({
        title: 'Robots Homepage',
        links: [
          [`${BASE}/support/security`, 'Security Advisories'],
          [`${BASE}/support/updates`, 'Software Updates'],
        ],
      }),
    });
    fetcher.pages.set(`${BASE}/support/security`, {
      body: htmlPage({ title: 'Should not be fetched' }),
    });
    fetcher.pages.set(`${BASE}/support/updates`, {
      body: htmlPage({ title: 'Updates', text: 'Updates text.' }),
    });

    const product = await createProduct();
    const body = (await research(product.id)).json().data;

    expect(fetcher.requests).not.toContain(`${BASE}/support/security`);
    expect(body.pagesRequiringReview).toContainEqual({
      url: `${BASE}/support/security`,
      reason: 'robots_disallowed',
    });
    expect(body.sources.map((source: { url: string }) => source.url)).toContain(
      `${BASE}/support/updates`,
    );
  });

  it('records a cross-host product URL as an external candidate and never fetches it', async () => {
    fetcher.pages.set(`${BASE}/`, {
      body: htmlPage({ title: 'Maker Home', text: 'Home text.' }),
    });

    const product = await createProduct({
      productUrl: 'https://retailer.example/products/123',
    });

    const body = (await research(product.id)).json().data;
    expect(body.externalCandidates).toContainEqual(
      expect.objectContaining({
        url: 'https://retailer.example/products/123',
        reason: 'external_domain',
      }),
    );
    expect(fetcher.requests).not.toContain('https://retailer.example/products/123');
  });

  it('never fetches more than five pages per research request', async () => {
    const links: Array<[string, string]> = Array.from({ length: 8 }, (_value, index) => [
      `${BASE}/support/update-${index + 1}`,
      `Firmware update ${index + 1}`,
    ]);
    fetcher.pages.set(`${BASE}/`, { body: htmlPage({ title: 'Limit Homepage', links }) });
    for (let index = 1; index <= 8; index += 1) {
      fetcher.pages.set(`${BASE}/support/update-${index}`, {
        body: htmlPage({ title: `Update ${index}`, text: 'Update text.' }),
      });
    }

    const product = await createProduct();
    const body = (await research(product.id)).json().data;

    expect(body.pagesFetched).toBe(5);
    expect(body.sources).toHaveLength(5);
    expect(body.pagesRequiringReview).toContainEqual(
      expect.objectContaining({ reason: 'limit_reached' }),
    );
    // Homepage plus four support pages, never a sixth page.
    expect(fetcher.requests.filter((url) => url !== `${BASE}/robots.txt`)).toHaveLength(5);
  });

  it('maps timeout, oversized and unsupported-content responses to failures', async () => {
    fetcher.pages.set(`${BASE}/`, {
      body: htmlPage({
        title: 'Failure Homepage',
        links: [
          [`${BASE}/support/slow`, 'Support Slow'],
          [`${BASE}/support/large`, 'Support Large'],
          [`${BASE}/support/pdf`, 'Support PDF'],
        ],
      }),
    });
    fetcher.pages.set(`${BASE}/support/slow`, {
      error: new FetchError('TIMEOUT', 'timed out', `${BASE}/support/slow`),
    });
    fetcher.pages.set(`${BASE}/support/large`, {
      error: new FetchError('TOO_LARGE', 'too large', `${BASE}/support/large`, 200),
    });
    fetcher.pages.set(`${BASE}/support/pdf`, {
      error: new FetchError(
        'UNSUPPORTED_CONTENT_TYPE',
        'only HTML is supported',
        `${BASE}/support/pdf`,
        200,
      ),
    });

    const product = await createProduct();
    const body = (await research(product.id)).json().data;

    expect(body.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: `${BASE}/support/slow`, reason: 'timeout' }),
        expect.objectContaining({ url: `${BASE}/support/large`, reason: 'response_too_large' }),
        expect.objectContaining({
          url: `${BASE}/support/pdf`,
          reason: 'unsupported_content_type',
        }),
      ]),
    );
    expect(body.pagesFetched).toBe(1);
  });

  it('creates no evidence records and invents no support dates', async () => {
    fetcher.pages.set(`${BASE}/`, {
      body: htmlPage({
        title: 'Policy Homepage',
        text: 'Support ends sometime in the future.',
        links: [[`${BASE}/support/end-of-support`, 'End of Support Policy']],
      }),
    });
    fetcher.pages.set(`${BASE}/support/end-of-support`, {
      body: htmlPage({ title: 'End of Support', text: 'No date stated here.' }),
    });

    const product = await createProduct();
    const response = await research(product.id);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.sources.length).toBe(2);

    const [evidenceCount] = await database.client`
      select count(*)::int as count from evidence where product_id = ${product.id}
    `;
    expect(evidenceCount?.count).toBe(0);

    const [dated] = await database.client`
      select count(*)::int as count
      from evidence
      where product_id = ${product.id} and normalized_date is not null
    `;
    expect(dated?.count).toBe(0);
  });

  it('returns a structured result distinguishing fetched, unvisited and failed pages', async () => {
    fetcher.pages.set(`${BASE}/`, {
      body: htmlPage({
        title: 'Structured Homepage',
        links: [
          [`${BASE}/support/security`, 'Security Advisory'],
          [`${BASE}/support/missing`, 'Support Downloads'],
          [`https://docs.${HOST}/manual`, 'Documentation'],
        ],
      }),
    });
    fetcher.pages.set(`${BASE}/support/security`, {
      body: htmlPage({ title: 'Advisory', text: 'Advisory text.' }),
    });
    // /support/missing deliberately has no mock response: HTTP 404.

    const product = await createProduct();
    const body = (await research(product.id)).json().data;

    expect(body.sources).toHaveLength(2);
    expect(body.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: `${BASE}/support/missing`, reason: 'http_error', statusCode: 404 }),
      ]),
    );
    expect(body.externalCandidates).toContainEqual(
      expect.objectContaining({ url: `https://docs.${HOST}/manual` }),
    );
    expect(body.storedSourceIds).toHaveLength(2);
    expect(body).toHaveProperty('researchedAt');
    expect(body).toHaveProperty('pagesDiscovered');
    expect(body).toHaveProperty('pagesRequiringReview');
  });
});
