import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { closeDatabase, createDatabase, type Database } from '../src/db/client.js';
import type { ClaimType, DatePrecision, ReviewStatus, SourceRelationshipType } from '../src/db/schema.js';
import { authHeaders, login, TEST_AUTH } from './helpers/test-auth.js';

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PREFIX = `Step6 Test ${RUN_ID}`;
const DOMAIN = `maker-${RUN_ID}.example.com`;
const BASE_URL = `https://${DOMAIN}`;

let app: FastifyInstance;
let database: Database;
let sequence = 0;

function nextSeq(): number {
  sequence += 1;
  return sequence;
}

function get(url: string) {
  return app.inject({ method: 'GET', url, headers: authHeaders(app) });
}

function post(url: string, payload?: unknown) {
  return app.inject({
    method: 'POST',
    url,
    payload: payload as object | undefined,
    headers: authHeaders(app),
  });
}

async function createManufacturer(overrides: { name?: string; website?: string | null } = {}) {
  const seq = nextSeq();
  const name = overrides.name ?? `${TEST_PREFIX} Maker ${seq}`;
  const website = overrides.website === undefined ? BASE_URL : overrides.website;
  const normalized = name.toLowerCase().trim();

  const [row] = await database.client`
    insert into manufacturers (name, normalized_name, website, country_code)
    values (${name}, ${normalized}, ${website}, 'US')
    returning id, name, website
  `;
  return row as { id: string; name: string; website: string | null };
}

async function createProduct(manufacturerId: string, overrides: { name?: string; modelIdentifier?: string } = {}) {
  const seq = nextSeq();
  const name = overrides.name ?? `${TEST_PREFIX} Product ${seq}`;
  const modelIdentifier = overrides.modelIdentifier ?? `MOD-${RUN_ID}-${seq}`;

  const [row] = await database.client`
    insert into products (manufacturer_id, name, model_identifier)
    values (${manufacturerId}, ${name}, ${modelIdentifier})
    returning id, name, model_identifier
  `;
  return row as { id: string; name: string; model_identifier: string };
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
  const title = overrides.title ?? `Page ${seq}`;

  const [row] = await database.client`
    insert into sources (url, domain, title, content_text, http_status, fetched_at)
    values (${url}, ${domain}, ${title}, ${contentText}, ${httpStatus}, now())
    returning id, url, domain, http_status, content_text
  `;
  return row as { id: string; url: string; domain: string; http_status: number | null; content_text: string | null };
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
  const explanation = params.explanation ?? 'Clear manufacturer end of support commitment.';
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
  app = buildApp({ database, logger: false, auth: TEST_AUTH });
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

describe('Evidence Verification, Conflict Detection & Human Review (Step 6)', () => {
  // Test 1: Evidence retrieval returns HTTP 200 with evidence array and pagination
  it('1. returns HTTP 200 with evidence array and pagination for a product', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource();
    await associateProductSource(p.id, s.id);
    await createEvidence({ productId: p.id, sourceId: s.id });

    const res = await get(`/api/v1/products/${p.id}/evidence`);
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(1);
    expect(body.data[0].productId).toBe(p.id);
    expect(body.data[0].source).toBeDefined();
    expect(body.data[0].source.url).toBe(s.url);
    expect(body.pagination).toEqual({
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
    });
  });

  // Test 2: Evidence detail retrieval returns single evidence with safe source info
  it('2. returns single evidence record with associated safe source information', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource({ title: 'Security Lifecycle Page' });
    await associateProductSource(p.id, s.id);
    const ev = await createEvidence({ productId: p.id, sourceId: s.id });

    const res = await get(`/api/v1/evidence/${ev.id}`);
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.data.id).toBe(ev.id);
    expect(body.data.claimType).toBe('support_end');
    expect(body.data.source).toBeDefined();
    expect(body.data.source.title).toBe('Security Lifecycle Page');
    // Confidential or bulky raw fields must not be leaked on safe source info
    expect(body.data.source.contentText).toBeUndefined();
    expect(body.data.reviews).toBeDefined();
    expect(Array.isArray(body.data.reviews)).toBe(true);
  });

  // Test 3: Product not found returns 404
  it('3. returns 404 when querying evidence for non-existent product UUID', async () => {
    const nonExistentId = '00000000-0000-4000-8000-000000000001';
    const res = await get(`/api/v1/products/${nonExistentId}/evidence`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PRODUCT_NOT_FOUND');
  });

  // Test 4: Invalid evidence ID returns 400
  it('4. returns 400 when requesting evidence detail with an invalid UUID format', async () => {
    const res = await get('/api/v1/evidence/not-a-valid-uuid');
    expect(res.statusCode).toBe(400);
  });

  // Test 5: Evidence pagination works across multiple pages
  it('5. correctly paginates evidence records across multiple pages', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource();
    await associateProductSource(p.id, s.id);

    const ev1 = await createEvidence({ productId: p.id, sourceId: s.id, rawText: 'Claim 1' });
    const ev2 = await createEvidence({ productId: p.id, sourceId: s.id, rawText: 'Claim 2' });

    const page1Res = await get(`/api/v1/products/${p.id}/evidence?page=1&pageSize=1`);
    expect(page1Res.statusCode).toBe(200);
    const page1Body = page1Res.json();
    expect(page1Body.data.length).toBe(1);
    expect(page1Body.pagination.total).toBe(2);
    expect(page1Body.pagination.totalPages).toBe(2);

    const page2Res = await get(`/api/v1/products/${p.id}/evidence?page=2&pageSize=1`);
    expect(page2Res.statusCode).toBe(200);
    const page2Body = page2Res.json();
    expect(page2Body.data.length).toBe(1);

    expect(page1Body.data[0].id).not.toBe(page2Body.data[0].id);
    const returnedIds = [page1Body.data[0].id, page2Body.data[0].id];
    expect(returnedIds).toContain(ev1.id);
    expect(returnedIds).toContain(ev2.id);
  });

  // Test 6: Claim-type filtering
  it('6. filters evidence by claimType', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource();
    await associateProductSource(p.id, s.id);

    await createEvidence({ productId: p.id, sourceId: s.id, claimType: 'support_start', dateText: '2022-01-01' });
    await createEvidence({ productId: p.id, sourceId: s.id, claimType: 'support_end', dateText: '2028-01-01' });

    const res = await get(`/api/v1/products/${p.id}/evidence?claimType=support_end`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0].claimType).toBe('support_end');
  });

  // Test 7: Review-status filtering
  it('7. filters evidence by reviewStatus', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource();
    await associateProductSource(p.id, s.id);

    await createEvidence({ productId: p.id, sourceId: s.id, reviewStatus: 'pending' });
    await createEvidence({ productId: p.id, sourceId: s.id, reviewStatus: 'rejected' });

    const res = await get(`/api/v1/products/${p.id}/evidence?reviewStatus=rejected`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0].reviewStatus).toBe('rejected');
  });

  // Test 8: Valid source integrity
  it('8. assessment flags sourceIntegrity as valid for HTTP 200, associated, registered domain', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const content = 'Guaranteed security updates until December 31, 2030.';
    const s = await createSource({ contentText: content, httpStatus: 200 });
    await associateProductSource(p.id, s.id);
    await createEvidence({
      productId: p.id,
      sourceId: s.id,
      quotedExcerpt: content,
      dateText: 'December 31, 2030',
    });

    const res = await get(`/api/v1/products/${p.id}/evidence/assessment`);
    expect(res.statusCode).toBe(200);
    const body = res.json().data;

    expect(body.summary.sourceIntegrityFailures).toBe(0);
    expect(body.items[0].sourceIntegrity.valid).toBe(true);
    expect(body.items[0].sourceIntegrity.reasons).toEqual([]);
  });

  // Test 9: Missing source integrity failure
  it('9. assessment flags sourceIntegrity failure when source does not exist or was deleted', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);

    // Source exists with empty text and not associated
    const s = await createSource({ contentText: null });
    // Not associated with product!
    await createEvidence({
      productId: p.id,
      sourceId: s.id,
      quotedExcerpt: 'Some excerpt',
    });

    const res = await get(`/api/v1/products/${p.id}/evidence/assessment`);
    expect(res.statusCode).toBe(200);
    const body = res.json().data;

    expect(body.summary.sourceIntegrityFailures).toBeGreaterThan(0);
    expect(body.items[0].sourceIntegrity.valid).toBe(false);
    expect(body.items[0].sourceIntegrity.reasons.some((r: string) => r.includes('not associated'))).toBe(true);
  });

  // Test 10: Invalid source HTTP status
  it('10. assessment flags sourceIntegrity failure when source HTTP status is 404', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource({ httpStatus: 404, contentText: '404 Not Found' });
    await associateProductSource(p.id, s.id);
    await createEvidence({ productId: p.id, sourceId: s.id, quotedExcerpt: '404 Not Found' });

    const res = await get(`/api/v1/products/${p.id}/evidence/assessment`);
    expect(res.statusCode).toBe(200);
    const body = res.json().data;

    expect(body.summary.sourceIntegrityFailures).toBe(1);
    expect(body.items[0].sourceIntegrity.valid).toBe(false);
    expect(body.items[0].sourceIntegrity.reasons.some((r: string) => r.includes('HTTP status: 404'))).toBe(true);
  });

  // Test 11: Quotation mismatch
  it('11. assessment flags quotationIntegrity failure when quotedExcerpt is not in source text', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource({ contentText: 'This page describes general battery safety precautions only.' });
    await associateProductSource(p.id, s.id);
    await createEvidence({
      productId: p.id,
      sourceId: s.id,
      quotedExcerpt: 'Software patches guaranteed for 5 years after purchase date.',
      dateText: null,
    });

    const res = await get(`/api/v1/products/${p.id}/evidence/assessment`);
    expect(res.statusCode).toBe(200);
    const body = res.json().data;

    expect(body.summary.quotationIntegrityFailures).toBe(1);
    expect(body.items[0].quotationIntegrity.valid).toBe(false);
    expect(body.items[0].quotationIntegrity.reasons.some((r: string) => r.includes('does not appear'))).toBe(true);
  });

  // Test 12: Missing supporting date text in quotation
  it('12. assessment flags quotationIntegrity failure when dateText does not appear in quotedExcerpt', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource({ contentText: 'The manufacturer provides periodic security updates as needed.' });
    await associateProductSource(p.id, s.id);
    await createEvidence({
      productId: p.id,
      sourceId: s.id,
      quotedExcerpt: 'The manufacturer provides periodic security updates as needed.',
      dateText: 'December 31, 2030', // dateText fabricated, does not appear in quote!
    });

    const res = await get(`/api/v1/products/${p.id}/evidence/assessment`);
    expect(res.statusCode).toBe(200);
    const body = res.json().data;

    expect(body.summary.quotationIntegrityFailures).toBe(1);
    expect(body.items[0].quotationIntegrity.valid).toBe(false);
    expect(body.items[0].quotationIntegrity.reasons.some((r: string) => r.includes('does not appear in the supporting quotation'))).toBe(true);
  });

  // Test 13: Support-end conflict detection
  it('13. detects conflict when two claims give contradictory support_end dates', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s1 = await createSource({ contentText: 'Updates guaranteed through December 31, 2028.' });
    const s2 = await createSource({ contentText: 'Security patches supported until December 31, 2032.' });
    await associateProductSource(p.id, s1.id);
    await associateProductSource(p.id, s2.id);

    const ev1 = await createEvidence({
      productId: p.id,
      sourceId: s1.id,
      claimType: 'support_end',
      quotedExcerpt: 'Updates guaranteed through December 31, 2028.',
      dateText: 'December 31, 2028',
      normalizedDate: '2028-12-31',
    });
    const ev2 = await createEvidence({
      productId: p.id,
      sourceId: s2.id,
      claimType: 'support_end',
      quotedExcerpt: 'Security patches supported until December 31, 2032.',
      dateText: 'December 31, 2032',
      normalizedDate: '2032-12-31',
    });

    const res = await get(`/api/v1/products/${p.id}/evidence/assessment`);
    expect(res.statusCode).toBe(200);
    const body = res.json().data;

    expect(body.detectedConflicts.length).toBe(1);
    const conflict = body.detectedConflicts[0];
    expect(conflict.claimType).toBe('support_end');
    expect(conflict.conflictingEvidenceIds).toContain(ev1.id);
    expect(conflict.conflictingEvidenceIds).toContain(ev2.id);
    expect(conflict.conflictExplanation).toContain('Contradictory support_end commitments');
  });

  // Test 14: Support-start conflict detection
  it('14. detects conflict when two claims give contradictory support_start dates', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s1 = await createSource({ contentText: 'Initial firmware release support started January 1, 2020.' });
    const s2 = await createSource({ contentText: 'Support for this product family started June 1, 2022.' });
    await associateProductSource(p.id, s1.id);
    await associateProductSource(p.id, s2.id);

    const ev1 = await createEvidence({
      productId: p.id,
      sourceId: s1.id,
      claimType: 'support_start',
      quotedExcerpt: 'Initial firmware release support started January 1, 2020.',
      dateText: 'January 1, 2020',
      normalizedDate: '2020-01-01',
    });
    const ev2 = await createEvidence({
      productId: p.id,
      sourceId: s2.id,
      claimType: 'support_start',
      quotedExcerpt: 'Support for this product family started June 1, 2022.',
      dateText: 'June 1, 2022',
      normalizedDate: '2022-06-01',
    });

    const res = await get(`/api/v1/products/${p.id}/evidence/assessment`);
    expect(res.statusCode).toBe(200);
    const body = res.json().data;

    expect(body.detectedConflicts.length).toBe(1);
    expect(body.detectedConflicts[0].claimType).toBe('support_start');
    expect(body.detectedConflicts[0].conflictingEvidenceIds).toContain(ev1.id);
    expect(body.detectedConflicts[0].conflictingEvidenceIds).toContain(ev2.id);
  });

  // Test 15: Different date precision handling
  it('15. classifies overlapping precision as manual review and disjoint precision as conflict', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s1 = await createSource({ contentText: 'Supported through December 2030.' });
    const s2 = await createSource({ contentText: 'Supported until 2030.' });
    await associateProductSource(p.id, s1.id);
    await associateProductSource(p.id, s2.id);

    // Overlapping: Month "December 2030" vs Year "2030"
    const ev1 = await createEvidence({
      productId: p.id,
      sourceId: s1.id,
      claimType: 'support_end',
      quotedExcerpt: 'Supported through December 2030.',
      dateText: 'December 2030',
      datePrecision: 'month',
      normalizedDate: null,
    });
    await createEvidence({
      productId: p.id,
      sourceId: s2.id,
      claimType: 'support_end',
      quotedExcerpt: 'Supported until 2030.',
      dateText: '2030',
      datePrecision: 'year',
      normalizedDate: null,
    });

    const res = await get(`/api/v1/products/${p.id}/evidence/assessment`);
    expect(res.statusCode).toBe(200);
    const body = res.json().data;

    // Overlapping should NOT be classified as a hard conflict
    expect(body.detectedConflicts.length).toBe(0);
    // Overlapping precision should be flagged in claimsRequiringManualReview
    expect(body.claimsRequiringManualReview.length).toBeGreaterThan(0);
    expect(body.claimsRequiringManualReview.some((c: { evidenceId: string }) => c.evidenceId === ev1.id)).toBe(true);

    // Now add disjoint precision: Year "2035"
    const s3 = await createSource({ contentText: 'Updates will cease in 2035.' });
    await associateProductSource(p.id, s3.id);
    await createEvidence({
      productId: p.id,
      sourceId: s3.id,
      claimType: 'support_end',
      quotedExcerpt: 'Updates will cease in 2035.',
      dateText: '2035',
      datePrecision: 'year',
      normalizedDate: null,
    });

    const res2 = await get(`/api/v1/products/${p.id}/evidence/assessment`);
    const body2 = res2.json().data;
    // Disjoint spans ("December 2030" vs "2035") MUST be detected as conflict
    expect(body2.detectedConflicts.length).toBe(1);
    expect(body2.detectedConflicts[0].conflictExplanation).toContain('across different precisions');
  });

  // Test 16: Duplicate corroborating evidence
  it('16. does not flag conflict when multiple sources corroborate the exact same date', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s1 = await createSource({ contentText: 'Firmware supported through December 31, 2030 on portal A.' });
    const s2 = await createSource({ contentText: 'Firmware supported through December 31, 2030 on portal B.' });
    await associateProductSource(p.id, s1.id);
    await associateProductSource(p.id, s2.id);

    await createEvidence({
      productId: p.id,
      sourceId: s1.id,
      claimType: 'support_end',
      quotedExcerpt: 'Firmware supported through December 31, 2030 on portal A.',
      dateText: 'December 31, 2030',
      normalizedDate: '2030-12-31',
    });
    await createEvidence({
      productId: p.id,
      sourceId: s2.id,
      claimType: 'support_end',
      quotedExcerpt: 'Firmware supported through December 31, 2030 on portal B.',
      dateText: 'December 31, 2030',
      normalizedDate: '2030-12-31',
    });

    const res = await get(`/api/v1/products/${p.id}/evidence/assessment`);
    expect(res.statusCode).toBe(200);
    const body = res.json().data;

    expect(body.detectedConflicts.length).toBe(0);
  });

  // Test 17: Multiple OS versions not classified as conflicts
  it('17. does not treat multiple supported os_version records as conflicts', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource({ contentText: 'Compatible with Android 13 and Android 14.' });
    await associateProductSource(p.id, s.id);

    await createEvidence({
      productId: p.id,
      sourceId: s.id,
      claimType: 'os_version',
      quotedExcerpt: 'Compatible with Android 13 and Android 14.',
      dateText: null,
      rawText: 'Android 13',
    });
    await createEvidence({
      productId: p.id,
      sourceId: s.id,
      claimType: 'os_version',
      quotedExcerpt: 'Compatible with Android 13 and Android 14.',
      dateText: null,
      rawText: 'Android 14',
    });

    const res = await get(`/api/v1/products/${p.id}/evidence/assessment`);
    expect(res.statusCode).toBe(200);
    const body = res.json().data;

    expect(body.detectedConflicts.length).toBe(0);
  });

  // Test 18: Rejected evidence excluded from conflicts
  it('18. excludes rejected evidence records from conflict calculation', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s1 = await createSource({ contentText: 'Security patches until December 31, 2028.' });
    const s2 = await createSource({ contentText: 'Security patches until December 31, 2032.' });
    await associateProductSource(p.id, s1.id);
    await associateProductSource(p.id, s2.id);

    await createEvidence({
      productId: p.id,
      sourceId: s1.id,
      claimType: 'support_end',
      quotedExcerpt: 'Security patches until December 31, 2028.',
      dateText: 'December 31, 2028',
      normalizedDate: '2028-12-31',
      reviewStatus: 'rejected', // Rejected by human reviewer
    });
    await createEvidence({
      productId: p.id,
      sourceId: s2.id,
      claimType: 'support_end',
      quotedExcerpt: 'Security patches until December 31, 2032.',
      dateText: 'December 31, 2032',
      normalizedDate: '2032-12-31',
      reviewStatus: 'pending',
    });

    const res = await get(`/api/v1/products/${p.id}/evidence/assessment`);
    expect(res.statusCode).toBe(200);
    const body = res.json().data;

    expect(body.detectedConflicts.length).toBe(0);
  });

  // Test 19: Evidence acceptance
  it('19. allows human reviewer to accept evidence with valid source', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource({ contentText: 'Supported until December 31, 2030.' });
    await associateProductSource(p.id, s.id);
    const ev = await createEvidence({
      productId: p.id,
      sourceId: s.id,
      quotedExcerpt: 'Supported until December 31, 2030.',
      dateText: 'December 31, 2030',
    });

    const res = await post(`/api/v1/evidence/${ev.id}/review`, {
      decision: 'accepted',
      reviewNote: 'Verified against official manufacturer support lifecycle policy.',
    });
    expect(res.statusCode).toBe(200);

    const body = res.json().data;
    expect(body.evidence.reviewStatus).toBe('accepted');
    expect(body.review.decision).toBe('accepted');
    expect(body.review.previousStatus).toBe('pending');
    expect(body.review.reviewNote).toBe('Verified against official manufacturer support lifecycle policy.');
  });

  // Test 20: Evidence rejection
  it('20. allows human reviewer to reject evidence with a note', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource({ contentText: 'Standard 1 year limited hardware warranty.' });
    await associateProductSource(p.id, s.id);
    const ev = await createEvidence({
      productId: p.id,
      sourceId: s.id,
      quotedExcerpt: 'Standard 1 year limited hardware warranty.',
      dateText: null,
    });

    const res = await post(`/api/v1/evidence/${ev.id}/review`, {
      decision: 'rejected',
      reviewNote: 'This is a hardware warranty statement, not security support.',
    });
    expect(res.statusCode).toBe(200);

    const body = res.json().data;
    expect(body.evidence.reviewStatus).toBe('rejected');
    expect(body.review.decision).toBe('rejected');
    expect(body.review.previousStatus).toBe('pending');
  });

  // Test 21: Required review-note validation
  it('21. rejects review submission when review note is missing or too short', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource();
    await associateProductSource(p.id, s.id);
    const ev = await createEvidence({ productId: p.id, sourceId: s.id });

    const resEmpty = await post(`/api/v1/evidence/${ev.id}/review`, {
      decision: 'accepted',
      reviewNote: '   ',
    });
    expect(resEmpty.statusCode).toBe(400);

    const resShort = await post(`/api/v1/evidence/${ev.id}/review`, {
      decision: 'accepted',
      reviewNote: 'ok',
    });
    expect(resShort.statusCode).toBe(400);
  });

  // Test 22: Invalid evidence cannot be accepted
  it('22. prevents acceptance of evidence whose source fails source integrity (HTTP 404)', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource({ httpStatus: 404, contentText: 'Not found' });
    await associateProductSource(p.id, s.id);
    const ev = await createEvidence({ productId: p.id, sourceId: s.id });

    const res = await post(`/api/v1/evidence/${ev.id}/review`, {
      decision: 'accepted',
      reviewNote: 'Attempting to approve invalid source evidence.',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('SOURCE_INTEGRITY_FAILED');
  });

  // Test 23: Previous review history preserved
  it('23. preserves full review history across multiple consecutive reviews', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource({ contentText: 'Supported until December 31, 2030.' });
    await associateProductSource(p.id, s.id);
    const ev = await createEvidence({
      productId: p.id,
      sourceId: s.id,
      quotedExcerpt: 'Supported until December 31, 2030.',
      dateText: 'December 31, 2030',
    });

    // First review: reject
    const res1 = await post(`/api/v1/evidence/${ev.id}/review`, {
      decision: 'rejected',
      reviewNote: 'First pass rejected due to uncertainty.',
    });
    expect(res1.statusCode).toBe(200);

    // Second review: accept after clarification
    const res2 = await post(`/api/v1/evidence/${ev.id}/review`, {
      decision: 'accepted',
      reviewNote: 'Second pass accepted after verifying manufacturer portal.',
    });
    expect(res2.statusCode).toBe(200);

    // Check detail
    const detailRes = await get(`/api/v1/evidence/${ev.id}`);
    expect(detailRes.statusCode).toBe(200);
    const reviews = detailRes.json().data.reviews;
    expect(reviews.length).toBe(2);
    expect(reviews[0].decision).toBe('accepted');
    expect(reviews[0].previousStatus).toBe('rejected');
    expect(reviews[1].decision).toBe('rejected');
    expect(reviews[1].previousStatus).toBe('pending');
  });

  // Test 24: Reassessment after review
  it('24. reflects updated review status in product assessment counts', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource({ contentText: 'Security support ends December 31, 2030.' });
    await associateProductSource(p.id, s.id);
    const ev = await createEvidence({
      productId: p.id,
      sourceId: s.id,
      quotedExcerpt: 'Security support ends December 31, 2030.',
      dateText: 'December 31, 2030',
    });

    // Before review: 1 pending, 0 accepted
    const beforeRes = await get(`/api/v1/products/${p.id}/evidence/assessment`);
    expect(beforeRes.statusCode).toBe(200);
    expect(beforeRes.json().data.summary.pendingReview).toBe(1);
    expect(beforeRes.json().data.summary.accepted).toBe(0);

    // Human review
    await post(`/api/v1/evidence/${ev.id}/review`, {
      decision: 'accepted',
      reviewNote: 'Officially verified and approved.',
    });

    // After review: 0 pending, 1 accepted
    const afterRes = await get(`/api/v1/products/${p.id}/evidence/assessment`);
    expect(afterRes.statusCode).toBe(200);
    expect(afterRes.json().data.summary.pendingReview).toBe(0);
    expect(afterRes.json().data.summary.accepted).toBe(1);
  });

  // Test 25: No automatic evidence approval
  it('25. ensures all newly ingested evidence defaults to pending review without auto-approval', async () => {
    const m = await createManufacturer();
    const p = await createProduct(m.id);
    const s = await createSource({ contentText: 'Updates provided until December 31, 2030.' });
    await associateProductSource(p.id, s.id);
    const ev = await createEvidence({
      productId: p.id,
      sourceId: s.id,
      quotedExcerpt: 'Updates provided until December 31, 2030.',
      dateText: 'December 31, 2030',
    });

    const assessRes = await get(`/api/v1/products/${p.id}/evidence/assessment`);
    expect(assessRes.statusCode).toBe(200);
    const body = assessRes.json().data;

    // Even with 100% valid integrity checks, evidence must remain pending review
    expect(body.items[0].overallIntegrity).toBe(true);
    expect(body.items[0].reviewStatus).toBe('pending');
    expect(body.summary.pendingReview).toBe(1);
    expect(body.summary.accepted).toBe(0);

    const detailRes = await get(`/api/v1/evidence/${ev.id}`);
    expect(detailRes.json().data.reviewStatus).toBe('pending');
  });
});
