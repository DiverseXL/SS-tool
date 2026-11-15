import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { closeDatabase, createDatabase, type Database } from '../src/db/client.js';
import type { ClaimType, DatePrecision, ReviewStatus, SourceRelationshipType } from '../src/db/schema.js';
import type { AiProvider } from '../src/extraction/provider.js';
import { authHeaders, login, TEST_AUTH } from './helpers/test-auth.js';

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PREFIX = `Step7 Test ${RUN_ID}`;
const DOMAIN = `public-maker-${RUN_ID}.example.com`;
const BASE_URL = `https://${DOMAIN}`;

let app: FastifyInstance;
let database: Database;
let sequence = 0;

// Fake AI provider to verify that public routes NEVER invoke AI
const fakeAiProvider: AiProvider = {
  name: 'monitored-fake-provider',
  complete: vi.fn().mockResolvedValue({ text: '{}', model: 'mock' }),
};

function nextSeq(): number {
  sequence += 1;
  return sequence;
}

function get(url: string) {
  return app.inject({ method: 'GET', url });
}

function post(url: string, payload?: unknown) {
  return app.inject({
    method: 'POST',
    url,
    payload: payload as object | undefined,
    headers: authHeaders(app),
  });
}

/** Builds a valid GTIN-14 string with a correct check digit. */
function makeGtin14(data: string): string {
  let sum = 0;
  for (let i = data.length - 1, weight = 3; i >= 0; i -= 1, weight = weight === 3 ? 1 : 3) {
    sum += Number(data[i]) * weight;
  }
  return `${data}${(10 - (sum % 10)) % 10}`;
}

async function createManufacturer(overrides: { name?: string; website?: string | null } = {}) {
  const seq = nextSeq();
  const name = overrides.name ?? `${TEST_PREFIX} Maker ${seq}`;
  const website = overrides.website === undefined ? BASE_URL : overrides.website;
  const normalized = name.toLowerCase().trim();

  const [row] = await database.client`
    insert into manufacturers (name, normalized_name, website, country_code)
    values (${name}, ${normalized}, ${website}, 'US')
    returning id, name, website, country_code as "countryCode"
  `;
  return row as { id: string; name: string; website: string | null; countryCode: string | null };
}

async function createProduct(
  manufacturerId: string,
  overrides: {
    name?: string;
    modelIdentifier?: string;
    gtin?: string | null;
    category?: string | null;
    productUrl?: string | null;
  } = {},
) {
  const seq = nextSeq();
  const name = overrides.name ?? `${TEST_PREFIX} Product ${seq}`;
  const modelIdentifier = overrides.modelIdentifier ?? `MOD-${RUN_ID}-${seq}`;
  const gtin = overrides.gtin === undefined ? null : overrides.gtin;
  const category = overrides.category ?? 'Smart Home Hub';
  const productUrl = overrides.productUrl ?? `${BASE_URL}/products/hub-${seq}`;

  const [row] = await database.client`
    insert into products (manufacturer_id, name, model_identifier, gtin, category, product_url)
    values (${manufacturerId}, ${name}, ${modelIdentifier}, ${gtin}, ${category}, ${productUrl})
    returning id, name, model_identifier as "modelIdentifier", gtin, category, product_url as "productUrl"
  `;
  return row as {
    id: string;
    name: string;
    modelIdentifier: string;
    gtin: string | null;
    category: string | null;
    productUrl: string | null;
  };
}

async function createSource(overrides: {
  url?: string;
  domain?: string;
  contentText?: string | null;
  httpStatus?: number | null;
  title?: string | null;
} = {}) {
  const seq = nextSeq();
  const url = overrides.url ?? `${BASE_URL}/support/page-${seq}`;
  const domain = overrides.domain ?? new URL(url).hostname;
  const contentText = overrides.contentText === undefined ? 'Device security updates are guaranteed until December 31, 2030.' : overrides.contentText;
  const httpStatus = overrides.httpStatus === undefined ? 200 : overrides.httpStatus;
  const title = overrides.title ?? `Support Page ${seq}`;

  const [row] = await database.client`
    insert into sources (url, domain, title, content_text, http_status, fetched_at)
    values (${url}, ${domain}, ${title}, ${contentText}, ${httpStatus}, now())
    returning id, url, domain, http_status, content_text, title
  `;
  return row as { id: string; url: string; domain: string; http_status: number | null; content_text: string | null; title: string | null };
}

async function associateProductSource(
  productId: string,
  sourceId: string,
  relationshipType: SourceRelationshipType = 'support_page',
) {
  await database.client`
    insert into product_sources (product_id, source_id, relationship_type)
    values (${productId}, ${sourceId}, ${relationshipType})
    on conflict do nothing
  `;
}

async function createEvidence(params: {
  productId: string;
  sourceId: string;
  claimType?: ClaimType;
  rawText?: string;
  quotedExcerpt?: string;
  dateText?: string | null;
  datePrecision?: DatePrecision | null;
  normalizedDate?: string | null;
  confidence?: number;
  explanation?: string;
  reviewStatus?: ReviewStatus;
  claimFingerprint?: string;
}) {
  const seq = nextSeq();
  const claimType = params.claimType ?? 'support_end';
  const rawText = params.rawText ?? 'Security updates guaranteed until December 31, 2030.';
  const quotedExcerpt = params.quotedExcerpt ?? 'Device security updates are guaranteed until December 31, 2030.';
  const dateText = params.dateText === undefined ? 'December 31, 2030' : params.dateText;
  const datePrecision = params.datePrecision === undefined ? 'day' : params.datePrecision;
  const normalizedDate = params.normalizedDate === undefined ? '2030-12-31' : params.normalizedDate;
  const confidence = params.confidence ?? 0.95;
  const explanation = params.explanation ?? 'Clear manufacturer support commitment.';
  const reviewStatus = params.reviewStatus ?? 'pending';
  const fingerprint = params.claimFingerprint ?? `fp-${RUN_ID}-${seq}`;

  const [row] = await database.client`
    insert into evidence (
      product_id, source_id, claim_type, raw_text, quoted_excerpt,
      date_text, date_precision, normalized_date, confidence,
      explanation, claim_fingerprint, extraction_method, review_status
    )
    values (
      ${params.productId}, ${params.sourceId}, ${claimType}, ${rawText}, ${quotedExcerpt},
      ${dateText}, ${datePrecision}, ${normalizedDate}, ${confidence},
      ${explanation}, ${fingerprint}, 'ai', ${reviewStatus}
    )
    returning id, product_id, source_id, claim_type, review_status, quoted_excerpt, date_text
  `;
  return row as {
    id: string;
    product_id: string;
    source_id: string;
    claim_type: ClaimType;
    review_status: ReviewStatus;
    quoted_excerpt: string;
    date_text: string | null;
  };
}

beforeAll(async () => {
  loadEnv();
  database = createDatabase(loadEnv().DATABASE_URL);
  await migrate(database.orm, { migrationsFolder: 'drizzle' });
  app = buildApp({
    database,
    logger: false,
    auth: TEST_AUTH,
    extraction: { provider: fakeAiProvider },
  });
  await app.ready();
  await login(app);
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
    await database.client`delete from sources where domain like ${`%${RUN_ID}%`}`;
  }
  if (app) {
    await app.close();
  }
  if (database) {
    await closeDatabase(database);
  }
});

describe('Public Support Card & Lookup API (Step 7)', () => {
  // Test 1: Product with accepted support-end evidence
  it('1. returns INFORMATION_AVAILABLE with populated supportEnd for accepted support_end evidence', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource({ title: 'Lifecycle Policy' });
    await associateProductSource(p.id, s.id);
    await createEvidence({
      productId: p.id,
      sourceId: s.id,
      claimType: 'support_end',
      quotedExcerpt: 'Guaranteed security updates until December 31, 2030.',
      dateText: 'December 31, 2030',
      normalizedDate: '2030-12-31',
      datePrecision: 'day',
      reviewStatus: 'accepted',
    });

    const res = await get(`/api/v1/public/products/${p.id}/support-card`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=30');

    const body = res.json().data;
    expect(body.product.id).toBe(p.id);
    expect(body.product.name).toBe(p.name);
    expect(body.product.manufacturer.name).toBe(m.name);
    expect(body.supportInformation.status).toBe('INFORMATION_AVAILABLE');
    expect(body.supportInformation.supportEnd).toEqual({
      value: '2030-12-31',
      displayValue: 'December 31, 2030',
      precision: 'day',
    });
    expect(body.supportInformation.supportStart).toBeNull();
    expect(body.supportInformation.summaryStatement).toContain('Manufacturer-stated security-update support until December 31, 2030.');
    expect(body.supportInformation.disclaimer).toContain('does not certify security');
    expect(body.supportInformation.claims.length).toBe(1);
    expect(body.supportInformation.sources.length).toBe(1);
    expect(body.supportInformation.sources[0].url).toBe(s.url);
  });

  // Test 2: Product with accepted support-start evidence
  it('2. returns INFORMATION_AVAILABLE with populated supportStart for accepted support_start evidence', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource();
    await associateProductSource(p.id, s.id);
    await createEvidence({
      productId: p.id,
      sourceId: s.id,
      claimType: 'support_start',
      quotedExcerpt: 'Initial support started January 1, 2022.',
      dateText: 'January 1, 2022',
      normalizedDate: '2022-01-01',
      datePrecision: 'day',
      reviewStatus: 'accepted',
    });

    const res = await get(`/api/v1/public/products/${p.id}/support-card`);
    expect(res.statusCode).toBe(200);

    const body = res.json().data;
    expect(body.supportInformation.status).toBe('INFORMATION_AVAILABLE');
    expect(body.supportInformation.supportStart).toEqual({
      value: '2022-01-01',
      displayValue: 'January 1, 2022',
      precision: 'day',
    });
    expect(body.supportInformation.supportEnd).toBeNull();
  });

  // Test 3: Product with no accepted evidence
  it('3. returns INSUFFICIENT_INFORMATION when product has no evidence records at all', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);

    const res = await get(`/api/v1/public/products/${p.id}/support-card`);
    expect(res.statusCode).toBe(200);

    const body = res.json().data;
    expect(body.supportInformation.status).toBe('INSUFFICIENT_INFORMATION');
    expect(body.supportInformation.supportStart).toBeNull();
    expect(body.supportInformation.supportEnd).toBeNull();
    expect(body.supportInformation.claims).toEqual([]);
    expect(body.supportInformation.sources).toEqual([]);
    expect(body.supportInformation.summaryStatement).toContain('Insufficient reviewed manufacturer security-support information');
  });

  // Test 4: Product with pending evidence only
  it('4. returns INSUFFICIENT_INFORMATION and does not expose pending claims to consumers', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource();
    await associateProductSource(p.id, s.id);
    await createEvidence({
      productId: p.id,
      sourceId: s.id,
      claimType: 'support_end',
      quotedExcerpt: 'Unreviewed text claiming support until 2035.',
      dateText: '2035',
      reviewStatus: 'pending',
    });

    const res = await get(`/api/v1/public/products/${p.id}/support-card`);
    expect(res.statusCode).toBe(200);

    const body = res.json().data;
    expect(body.supportInformation.status).toBe('INSUFFICIENT_INFORMATION');
    expect(body.supportInformation.supportEnd).toBeNull();
    // Must NOT leak pending evidence
    expect(body.supportInformation.claims).toEqual([]);
    expect(body.supportInformation.sources).toEqual([]);
  });

  // Test 5: Product with rejected evidence only
  it('5. returns INSUFFICIENT_INFORMATION and does not expose rejected evidence as positive commitments', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource();
    await associateProductSource(p.id, s.id);
    await createEvidence({
      productId: p.id,
      sourceId: s.id,
      claimType: 'support_end',
      quotedExcerpt: 'Rejected claim about 1-year warranty.',
      dateText: null,
      reviewStatus: 'rejected',
    });

    const res = await get(`/api/v1/public/products/${p.id}/support-card`);
    expect(res.statusCode).toBe(200);

    const body = res.json().data;
    expect(body.supportInformation.status).toBe('INSUFFICIENT_INFORMATION');
    expect(body.supportInformation.claims).toEqual([]);
    expect(body.supportInformation.supportEnd).toBeNull();
  });

  // Test 6: Conflicting accepted support-end commitments
  it('6. returns CONFLICTING_INFORMATION and does not arbitrarily select a date when accepted commitments conflict', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s1 = await createSource({ contentText: 'Updates through December 31, 2028.' });
    const s2 = await createSource({ contentText: 'Security patches supported until December 31, 2032.' });
    await associateProductSource(p.id, s1.id);
    await associateProductSource(p.id, s2.id);

    await createEvidence({
      productId: p.id,
      sourceId: s1.id,
      claimType: 'support_end',
      quotedExcerpt: 'Updates through December 31, 2028.',
      dateText: 'December 31, 2028',
      normalizedDate: '2028-12-31',
      reviewStatus: 'accepted',
    });
    await createEvidence({
      productId: p.id,
      sourceId: s2.id,
      claimType: 'support_end',
      quotedExcerpt: 'Security patches supported until December 31, 2032.',
      dateText: 'December 31, 2032',
      normalizedDate: '2032-12-31',
      reviewStatus: 'accepted',
    });

    const res = await get(`/api/v1/public/products/${p.id}/support-card`);
    expect(res.statusCode).toBe(200);

    const body = res.json().data;
    expect(body.supportInformation.status).toBe('CONFLICTING_INFORMATION');
    // Publication Rule 5: If conflicting support-end commitments exist, do NOT arbitrarily select one date
    expect(body.supportInformation.supportEnd).toBeNull();
    expect(body.supportInformation.summaryStatement).toContain('Conflicting manufacturer support commitments have been identified');
  });

  // Test 7: Conflicting pending and accepted commitments
  it('7. returns CONFLICTING_INFORMATION when a pending claim contradicts an accepted claim, without leaking pending details', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s1 = await createSource({ contentText: 'Support guaranteed until December 31, 2030.' });
    const s2 = await createSource({ contentText: 'Support officially terminated December 31, 2025.' });
    await associateProductSource(p.id, s1.id);
    await associateProductSource(p.id, s2.id);

    await createEvidence({
      productId: p.id,
      sourceId: s1.id,
      claimType: 'support_end',
      quotedExcerpt: 'Support guaranteed until December 31, 2030.',
      dateText: 'December 31, 2030',
      normalizedDate: '2030-12-31',
      reviewStatus: 'accepted',
    });
    await createEvidence({
      productId: p.id,
      sourceId: s2.id,
      claimType: 'support_end',
      quotedExcerpt: 'Support officially terminated December 31, 2025.',
      dateText: 'December 31, 2025',
      normalizedDate: '2025-12-31',
      reviewStatus: 'pending', // Pending claim contradicts accepted claim!
    });

    const res = await get(`/api/v1/public/products/${p.id}/support-card`);
    expect(res.statusCode).toBe(200);

    const body = res.json().data;
    expect(body.supportInformation.status).toBe('CONFLICTING_INFORMATION');
    expect(body.supportInformation.supportEnd).toBeNull();
    // Privacy protection: pending evidence must NEVER appear in the public claims list
    expect(body.supportInformation.claims.every((c: { reviewStatus: string }) => c.reviewStatus === 'accepted')).toBe(true);
    expect(body.supportInformation.claims.some((c: { dateText: string | null }) => c.dateText === 'December 31, 2025')).toBe(false);
  });

  // Test 8: Corroborating manufacturer sources
  it('8. presents multiple accepted sources confirming the same commitment as corroborating sources', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s1 = await createSource({ title: 'Portal A Announcement' });
    const s2 = await createSource({ title: 'Portal B Policy' });
    await associateProductSource(p.id, s1.id);
    await associateProductSource(p.id, s2.id);

    await createEvidence({
      productId: p.id,
      sourceId: s1.id,
      claimType: 'support_end',
      quotedExcerpt: 'Supported until December 31, 2030 on Portal A.',
      dateText: 'December 31, 2030',
      normalizedDate: '2030-12-31',
      reviewStatus: 'accepted',
    });
    await createEvidence({
      productId: p.id,
      sourceId: s2.id,
      claimType: 'support_end',
      quotedExcerpt: 'Supported until December 31, 2030 on Portal B.',
      dateText: 'December 31, 2030',
      normalizedDate: '2030-12-31',
      reviewStatus: 'accepted',
    });

    const res = await get(`/api/v1/public/products/${p.id}/support-card`);
    expect(res.statusCode).toBe(200);

    const body = res.json().data;
    expect(body.supportInformation.status).toBe('INFORMATION_AVAILABLE');
    expect(body.supportInformation.supportEnd?.value).toBe('2030-12-31');
    // Both corroborating sources appear in public sources
    expect(body.supportInformation.sources.length).toBe(2);
    const urls = body.supportInformation.sources.map((s: { url: string }) => s.url);
    expect(urls).toContain(s1.url);
    expect(urls).toContain(s2.url);
    expect(body.supportInformation.claims.length).toBe(2);
  });

  // Test 9: Month-only date precision
  it('9. preserves month-only date precision without manufacturing an exact calendar day', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource({ contentText: 'Security support until December 2030.' });
    await associateProductSource(p.id, s.id);
    await createEvidence({
      productId: p.id,
      sourceId: s.id,
      claimType: 'support_end',
      quotedExcerpt: 'Security support until December 2030.',
      dateText: 'December 2030',
      datePrecision: 'month',
      normalizedDate: null,
      reviewStatus: 'accepted',
    });

    const res = await get(`/api/v1/public/products/${p.id}/support-card`);
    expect(res.statusCode).toBe(200);

    const body = res.json().data;
    expect(body.supportInformation.supportEnd).toEqual({
      value: null, // Value is null because month precision cannot be exact day
      displayValue: 'December 2030',
      precision: 'month',
    });
    expect(body.supportInformation.summaryStatement).toContain('until December 2030.');
  });

  // Test 10: Year-only date precision
  it('10. preserves year-only date precision without manufacturing an exact calendar day', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource({ contentText: 'Security support until 2032.' });
    await associateProductSource(p.id, s.id);
    await createEvidence({
      productId: p.id,
      sourceId: s.id,
      claimType: 'support_end',
      quotedExcerpt: 'Security support until 2032.',
      dateText: '2032',
      datePrecision: 'year',
      normalizedDate: null,
      reviewStatus: 'accepted',
    });

    const res = await get(`/api/v1/public/products/${p.id}/support-card`);
    expect(res.statusCode).toBe(200);

    const body = res.json().data;
    expect(body.supportInformation.supportEnd).toEqual({
      value: null,
      displayValue: '2032',
      precision: 'year',
    });
    expect(body.supportInformation.summaryStatement).toContain('until 2032.');
  });

  // Test 11: Accepted policy statements
  it('11. surfaces accepted policy statements in the public card', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource();
    await associateProductSource(p.id, s.id);
    await createEvidence({
      productId: p.id,
      sourceId: s.id,
      claimType: 'policy',
      rawText: 'Critical security patches are delivered within 30 days of vulnerability disclosure.',
      quotedExcerpt: 'Critical security patches are delivered within 30 days of vulnerability disclosure.',
      dateText: null,
      reviewStatus: 'accepted',
    });

    const res = await get(`/api/v1/public/products/${p.id}/support-card`);
    expect(res.statusCode).toBe(200);

    const body = res.json().data;
    expect(body.supportInformation.status).toBe('INFORMATION_AVAILABLE');
    expect(body.supportInformation.policyStatements).toContain(
      'Critical security patches are delivered within 30 days of vulnerability disclosure.',
    );
  });

  // Test 12: OS-version claims
  it('12. surfaces accepted OS-version claims in the public card', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource();
    await associateProductSource(p.id, s.id);
    await createEvidence({
      productId: p.id,
      sourceId: s.id,
      claimType: 'os_version',
      rawText: 'FreeRTOS 10.4',
      quotedExcerpt: 'Compatible with FreeRTOS 10.4',
      dateText: null,
      reviewStatus: 'accepted',
    });

    const res = await get(`/api/v1/public/products/${p.id}/support-card`);
    expect(res.statusCode).toBe(200);

    const body = res.json().data;
    expect(body.supportInformation.status).toBe('INFORMATION_AVAILABLE');
    expect(body.supportInformation.operatingSystems).toContain('FreeRTOS 10.4');
  });

  // Test 13: Invalid product ID
  it('13. returns HTTP 400 when product ID in support-card URL is an invalid UUID', async () => {
    const res = await get('/api/v1/public/products/invalid-uuid/support-card');
    expect(res.statusCode).toBe(400);
  });

  // Test 14: Unknown product
  it('14. returns HTTP 404 when product ID does not exist in the database', async () => {
    const nonExistentId = '00000000-0000-4000-8000-000000000001';
    const res = await get(`/api/v1/public/products/${nonExistentId}/support-card`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PRODUCT_NOT_FOUND');
  });

  // Test 15: GTIN lookup
  it('15. looks up product successfully by GTIN', async () => {
    const m = await createManufacturer();
    const gtin = makeGtin14(`0123456789${nextSeq().toString().padStart(3, '0')}`);
    const p = await createProduct(m.id, { gtin });

    const res = await get(`/api/v1/public/products/lookup?gtin=${gtin}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=30');

    const body = res.json().data;
    expect(body.product.id).toBe(p.id);
    expect(body.product.gtin).toBe(gtin);
    expect(body.supportCardUrl).toBe(`/api/v1/public/products/${p.id}/support-card`);
  });

  // Test 16: Manufacturer/model lookup
  it('16. looks up product successfully by manufacturer name and modelIdentifier', async () => {
    const m = await createManufacturer();
    const model = `MODEL-SPECIFIC-${nextSeq()}`;
    const p = await createProduct(m.id, { modelIdentifier: model });

    const res = await get(`/api/v1/public/products/lookup?manufacturer=${encodeURIComponent(m.name)}&modelIdentifier=${model}`);
    expect(res.statusCode).toBe(200);

    const body = res.json().data;
    expect(body.product.id).toBe(p.id);
    expect(body.product.modelIdentifier).toBe(model);
    expect(body.supportCardUrl).toBe(`/api/v1/public/products/${p.id}/support-card`);
  });

  // Test 17: Ambiguous lookup results
  it('17. returns HTTP 409 Conflict when GTIN matches multiple products ambiguously', async () => {
    const m1 = await createManufacturer();
    const m2 = await createManufacturer();
    const sharedGtin = makeGtin14(`999888777${nextSeq().toString().padStart(4, '0')}`);

    // Create two products with the same GTIN across different manufacturers
    await createProduct(m1.id, { gtin: sharedGtin });
    await createProduct(m2.id, { gtin: sharedGtin });

    const res = await get(`/api/v1/public/products/lookup?gtin=${sharedGtin}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('AMBIGUOUS_PRODUCT_MATCH');
  });

  // Test 18: Missing lookup parameters
  it('18. returns HTTP 400 when lookup request lacks both GTIN and manufacturer/model parameters', async () => {
    const resEmpty = await get('/api/v1/public/products/lookup');
    expect(resEmpty.statusCode).toBe(400);

    const resOnlyMaker = await get('/api/v1/public/products/lookup?manufacturer=Acme');
    expect(resOnlyMaker.statusCode).toBe(400);

    const resOnlyModel = await get('/api/v1/public/products/lookup?modelIdentifier=Hub-1');
    expect(resOnlyModel.statusCode).toBe(400);
  });

  // Test 19: Reviewer notes are not exposed
  it('19. does not expose internal reviewer notes in public responses', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource();
    await associateProductSource(p.id, s.id);
    const ev = await createEvidence({
      productId: p.id,
      sourceId: s.id,
      quotedExcerpt: 'Guaranteed security updates until December 31, 2030.',
      dateText: 'December 31, 2030',
      reviewStatus: 'pending',
    });

    // Submit review with confidential internal notes
    const confidentialNote = 'INTERNAL NOTE: Verified with senior security compliance lead off-record.';
    await post(`/api/v1/evidence/${ev.id}/review`, {
      decision: 'accepted',
      reviewNote: confidentialNote,
    });

    const res = await get(`/api/v1/public/products/${p.id}/support-card`);
    expect(res.statusCode).toBe(200);

    const rawResponseText = res.body;
    expect(rawResponseText).not.toContain(confidentialNote);
    expect(rawResponseText).not.toContain('reviewNote');
    expect(rawResponseText).not.toContain('previousStatus');
  });

  // Test 20: AI provider information is not exposed
  it('20. does not expose AI provider information, model names, confidence, or fingerprints', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource();
    await associateProductSource(p.id, s.id);
    await createEvidence({
      productId: p.id,
      sourceId: s.id,
      confidence: 0.9876,
      explanation: 'Internal AI chain-of-thought reason.',
      claimFingerprint: 'internal-secret-fingerprint-xyz',
      reviewStatus: 'accepted',
    });

    const res = await get(`/api/v1/public/products/${p.id}/support-card`);
    expect(res.statusCode).toBe(200);

    const rawResponseText = res.body;
    expect(rawResponseText).not.toContain('0.9876');
    expect(rawResponseText).not.toContain('confidence');
    expect(rawResponseText).not.toContain('internal-secret-fingerprint-xyz');
    expect(rawResponseText).not.toContain('claimFingerprint');
    expect(rawResponseText).not.toContain('extractionMethod');
    expect(rawResponseText).not.toContain('Internal AI chain-of-thought reason');
  });

  // Test 21: Evidence review changes affect public responses
  it('21. dynamically reflects human review status changes in public support card', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource({ contentText: 'Support updates provided through December 31, 2030.' });
    await associateProductSource(p.id, s.id);
    const ev = await createEvidence({
      productId: p.id,
      sourceId: s.id,
      quotedExcerpt: 'Support updates provided through December 31, 2030.',
      dateText: 'December 31, 2030',
      normalizedDate: '2030-12-31',
      reviewStatus: 'pending',
    });

    // Before review: status must be INSUFFICIENT_INFORMATION
    const beforeRes = await get(`/api/v1/public/products/${p.id}/support-card`);
    expect(beforeRes.statusCode).toBe(200);
    expect(beforeRes.json().data.supportInformation.status).toBe('INSUFFICIENT_INFORMATION');
    expect(beforeRes.json().data.supportInformation.supportEnd).toBeNull();

    // Human reviewer reviews and accepts the claim
    const reviewRes = await post(`/api/v1/evidence/${ev.id}/review`, {
      decision: 'accepted',
      reviewNote: 'Verified against manufacturer lifecycle support schedule.',
    });
    expect(reviewRes.statusCode).toBe(200);

    // After review: status immediately transitions to INFORMATION_AVAILABLE with date populated
    const afterRes = await get(`/api/v1/public/products/${p.id}/support-card`);
    expect(afterRes.statusCode).toBe(200);
    expect(afterRes.json().data.supportInformation.status).toBe('INFORMATION_AVAILABLE');
    expect(afterRes.json().data.supportInformation.supportEnd).toEqual({
      value: '2030-12-31',
      displayValue: 'December 31, 2030',
      precision: 'day',
    });
  });

  // Test 22: Public routes do not trigger AI or external HTTP requests
  it('22. executes public routes without triggering AI calls or external HTTP crawling', async () => {
    const m = await createManufacturer();
    const gtin = makeGtin14(`333222111${nextSeq().toString().padStart(4, '0')}`);
    const p = await createProduct(m.id, { gtin });

    // Reset fake AI provider call counter
    (fakeAiProvider.complete as any).mockClear();

    // Perform public lookup
    const lookupRes = await get(`/api/v1/public/products/lookup?gtin=${gtin}`);
    expect(lookupRes.statusCode).toBe(200);

    // Perform public support card retrieval
    const cardRes = await get(`/api/v1/public/products/${p.id}/support-card`);
    expect(cardRes.statusCode).toBe(200);

    // AI provider complete must NOT have been called
    expect(fakeAiProvider.complete).not.toHaveBeenCalled();
  });
});

