import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { closeDatabase, createDatabase, type Database } from '../src/db/client.js';
import { authCookie, login, TEST_AUTH } from './helpers/test-auth.js';

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PREFIX = `Step9B2 Review ${RUN_ID}`;
const HOST = `review-${RUN_ID}.test`;
const BASE = `https://${HOST}`;
const QUOTE_2030 = 'Security updates will be provided until December 2030.';
const QUOTE_2032 = 'Security updates will be provided until December 2032.';

let app: FastifyInstance;
let shortSessionApp: FastifyInstance;
let database: Database;
let manufacturerId: string;
let conflictProductId: string;
let ambiguousProductId: string;
let conflict2030Id: string;
let conflict2032Id: string;
let noDateId: string;
let ambiguousMonthId: string;
let ambiguousYearId: string;
let thirdPartyId: string;
let invalidQuotationId: string;

function request(method: 'GET' | 'POST', url: string, target: FastifyInstance = app, payload?: unknown) {
  return target.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
    headers: { cookie: authCookie(target) },
  });
}

function review(evidenceId: string, payload: Record<string, unknown>, target: FastifyInstance = app) {
  return request('POST', `/api/v1/evidence/${evidenceId}/review`, target, payload);
}

async function createManufacturer(): Promise<string> {
  const response = await request('POST', '/api/v1/manufacturers', app, {
    name: `${TEST_PREFIX} Maker`,
    website: BASE,
    countryCode: 'GB',
  });
  expect(response.statusCode).toBe(201);
  return response.json().data.id as string;
}

async function createProduct(name: string, model: string): Promise<string> {
  const response = await request('POST', '/api/v1/products', app, {
    manufacturerId,
    name,
    modelIdentifier: model,
    category: 'Review fixture',
  });
  expect(response.statusCode).toBe(201);
  return response.json().data.id as string;
}

async function createSource(options: {
  slug: string;
  domain?: string;
  title: string;
  content: string;
  httpStatus?: number | null;
}): Promise<string> {
  const httpStatus = options.httpStatus === undefined ? 200 : options.httpStatus;
  const fetched = httpStatus !== null && httpStatus >= 200 && httpStatus < 300;
  const [source] = await database.client`
    insert into sources (
      url, domain, title, description, content_text, http_status, content_hash, fetched_at
    ) values (
      ${`${BASE}/support/${options.slug}-${RUN_ID}`},
      ${options.domain ?? HOST},
      ${options.title},
      'Review source fixture',
      ${options.content},
      ${httpStatus},
      ${fetched ? `hash-${options.slug}-${RUN_ID}` : null},
      ${fetched ? new Date().toISOString() : null}
    )
    returning id
  `;
  return source?.id as string;
}

async function createEvidence(options: {
  productId: string;
  sourceId: string;
  claimType?: 'support_start' | 'support_end' | 'os_version' | 'policy';
  rawText: string;
  quotation: string;
  dateText?: string | null;
  datePrecision?: 'day' | 'month' | 'year' | null;
  normalizedDate?: string | null;
  reviewStatus?: 'pending' | 'accepted' | 'rejected';
}): Promise<string> {
  await database.client`
    insert into product_sources (product_id, source_id, relationship_type)
    values (${options.productId}, ${options.sourceId}, 'support_page')
    on conflict do nothing
  `;

  const [row] = await database.client`
    insert into evidence (
      product_id, source_id, claim_type, raw_text, quoted_excerpt,
      date_text, date_precision, normalized_date, confidence, explanation,
      extraction_method, review_status
    ) values (
      ${options.productId}, ${options.sourceId}, ${options.claimType ?? 'support_end'},
      ${options.rawText}, ${options.quotation}, ${options.dateText ?? null},
      ${options.datePrecision ?? null}, ${options.normalizedDate ?? null}, 0.91,
      'Synthetic review fixture only.', 'ai', ${options.reviewStatus ?? 'pending'}
    )
    returning id
  `;
  return row?.id as string;
}

async function queue(search = TEST_PREFIX, reviewStatus = 'all') {
  const params = new URLSearchParams({
    page: '1',
    pageSize: '100',
    reviewStatus,
    search,
  });
  const response = await request('GET', `/api/v1/dashboard/evidence-queue?${params.toString()}`);
  expect(response.statusCode).toBe(200);
  return response.json();
}

beforeAll(async () => {
  loadEnv();
  database = createDatabase(loadEnv().DATABASE_URL);
  await migrate(database.orm, { migrationsFolder: 'drizzle' });

  app = buildApp({ database, logger: false, auth: TEST_AUTH });
  await app.ready();
  await login(app);

  shortSessionApp = buildApp({
    database,
    logger: false,
    auth: { ...TEST_AUTH, sessionTtlMs: 40 },
  });
  await shortSessionApp.ready();

  manufacturerId = await createManufacturer();
  conflictProductId = await createProduct(`${TEST_PREFIX} Conflict product`, `RB2-${RUN_ID}-1`);
  ambiguousProductId = await createProduct(`${TEST_PREFIX} Ambiguous product`, `RB2-${RUN_ID}-2`);

  const source2030 = await createSource({
    slug: 'source-2030',
    title: 'Security update policy 2030',
    content: `Support timeline. ${QUOTE_2030} Further lifecycle notes.`,
  });
  const source2032 = await createSource({
    slug: 'source-2032',
    title: 'Security update policy 2032',
    content: `Support timeline. ${QUOTE_2032} Further lifecycle notes.`,
  });
  const sourceYear = await createSource({
    slug: 'source-year',
    title: 'Lifecycle year statement',
    content: 'Support timeline. Security updates will be provided through 2030.',
  });
  const sourceThirdParty = await createSource({
    slug: 'third-party',
    domain: `retailer-${RUN_ID}.example`,
    title: 'Retailer support page',
    content: `Retailer copy. ${QUOTE_2030}`,
  });
  const sourceInvalidQuote = await createSource({
    slug: 'invalid-quotation',
    title: 'Source without the claimed quote',
    content: 'This page contains unrelated product marketing and no support commitment.',
  });

  conflict2030Id = await createEvidence({
    productId: conflictProductId,
    sourceId: source2030,
    rawText: 'Security updates are provided until December 2030.',
    quotation: QUOTE_2030,
    dateText: 'December 2030',
    datePrecision: 'month',
  });
  conflict2032Id = await createEvidence({
    productId: conflictProductId,
    sourceId: source2032,
    rawText: 'Security updates are provided until December 2032.',
    quotation: QUOTE_2032,
    dateText: 'December 2032',
    datePrecision: 'month',
  });
  noDateId = await createEvidence({
    productId: conflictProductId,
    sourceId: source2030,
    rawText: 'Security updates follow the published lifecycle policy.',
    quotation: QUOTE_2030,
    dateText: null,
  });
  ambiguousMonthId = await createEvidence({
    productId: ambiguousProductId,
    sourceId: source2030,
    rawText: 'Security updates are provided until December 2030.',
    quotation: QUOTE_2030,
    dateText: 'December 2030',
    datePrecision: 'month',
  });
  ambiguousYearId = await createEvidence({
    productId: ambiguousProductId,
    sourceId: sourceYear,
    rawText: 'Security updates are provided through 2030.',
    quotation: 'Security updates will be provided through 2030.',
    dateText: '2030',
    datePrecision: 'year',
  });
  thirdPartyId = await createEvidence({
    productId: conflictProductId,
    sourceId: sourceThirdParty,
    claimType: 'policy',
    rawText: 'Security updates are provided until December 2030.',
    quotation: QUOTE_2030,
    dateText: 'December 2030',
    datePrecision: 'month',
  });
  invalidQuotationId = await createEvidence({
    productId: conflictProductId,
    sourceId: sourceInvalidQuote,
    claimType: 'policy',
    rawText: 'Security updates are provided until December 2030.',
    quotation: QUOTE_2030,
    dateText: 'December 2030',
    datePrecision: 'month',
  });
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
  await Promise.all([app?.close(), shortSessionApp?.close()]);
  if (database) await closeDatabase(database);
});

describe('evidence review authentication and page shell', () => {
  it('requires authentication for the review page and queue API', async () => {
    const page = await app.inject({ method: 'GET', url: '/dashboard/review' });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe(
      `/login?next=${encodeURIComponent('/dashboard/review')}`,
    );

    const queueResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/evidence-queue',
    });
    expect(queueResponse.statusCode).toBe(401);
    expect(queueResponse.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('serves the review shell with its navigation item', async () => {
    const response = await request('GET', '/dashboard/review');
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data-nav="review"');
    expect(response.body).toContain('href="/dashboard/review"');
    expect(response.body).toContain('id="view"');
  });

  it('rejects expired sessions on the review page and queue API', async () => {
    await login(shortSessionApp);
    await new Promise((resolve) => setTimeout(resolve, 90));

    const page = await shortSessionApp.inject({ method: 'GET', url: '/dashboard/review' });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toContain('/login?next=');

    const api = await shortSessionApp.inject({
      method: 'GET',
      url: '/api/v1/dashboard/evidence-queue',
    });
    expect(api.statusCode).toBe(401);
  });
});

describe('global evidence queue', () => {
  it('loads real PostgreSQL evidence with product and manufacturer context', async () => {
    const body = await queue();
    expect(body.pagination.pageSize).toBe(100);
    expect(body.pagination.total).toBe(7);
    expect(body.counts).toMatchObject({
      all: expect.any(Number),
      pending: expect.any(Number),
      accepted: expect.any(Number),
      rejected: expect.any(Number),
      conflicting: expect.any(Number),
    });

    const item = body.data.find((row: { id: string }) => row.id === conflict2030Id);
    expect(item).toMatchObject({
      productId: conflictProductId,
      claimType: 'support_end',
      statement: 'Security updates are provided until December 2030.',
      dateText: 'December 2030',
      datePrecision: 'month',
      status: 'pending',
      conflicting: true,
      product: {
        name: `${TEST_PREFIX} Conflict product`,
        modelIdentifier: `RB2-${RUN_ID}-1`,
        category: 'Review fixture',
      },
      manufacturer: { name: `${TEST_PREFIX} Maker` },
      source: {
        domain: HOST,
        title: 'Security update policy 2030',
      },
    });
    expect(item).not.toHaveProperty('confidence');
    expect(item).not.toHaveProperty('claimFingerprint');
  });

  it('paginates the queue without loading every product separately', async () => {
    const params = new URLSearchParams({
      page: '1',
      pageSize: '2',
      reviewStatus: 'pending',
      search: TEST_PREFIX,
    });
    const first = await request('GET', `/api/v1/dashboard/evidence-queue?${params.toString()}`);
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toHaveLength(2);
    expect(first.json().pagination).toMatchObject({ page: 1, pageSize: 2, total: 7, totalPages: 4 });

    params.set('page', '2');
    const second = await request('GET', `/api/v1/dashboard/evidence-queue?${params.toString()}`);
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toHaveLength(2);
    const firstIds = first.json().data.map((row: { id: string }) => row.id);
    const secondIds = second.json().data.map((row: { id: string }) => row.id);
    expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);
  });

  it('filters by review status and finds only evidence inside detected conflicts', async () => {
    const pending = await queue(TEST_PREFIX, 'pending');
    expect(pending.data).toHaveLength(7);

    const accepted = await queue(TEST_PREFIX, 'accepted');
    expect(accepted.data).toHaveLength(0);

    const rejected = await queue(TEST_PREFIX, 'rejected');
    expect(rejected.data).toHaveLength(0);

    const conflicting = await queue(TEST_PREFIX, 'conflicting');
    expect(conflicting.data.map((row: { id: string }) => row.id).sort()).toEqual(
      [conflict2030Id, conflict2032Id].sort(),
    );
    expect(conflicting.data.every((row: { conflicting: boolean }) => row.conflicting)).toBe(true);
    expect(conflicting.data.map((row: { id: string }) => row.id)).not.toContain(ambiguousMonthId);
  });

  it('searches existing product identifiers and manufacturer names', async () => {
    const byModel = await queue(`RB2-${RUN_ID}-2`, 'all');
    expect(byModel.data.length).toBeGreaterThanOrEqual(2);
    expect(
      byModel.data.every((row: { product: { modelIdentifier: string } }) =>
        row.product.modelIdentifier.includes(`RB2-${RUN_ID}-2`),
      ),
    ).toBe(true);

    const byName = await queue(`${TEST_PREFIX} Conflict`, 'all');
    expect(byName.data).toHaveLength(5);
    expect(
      byName.data.every((row: { product: { name: string } }) =>
        row.product.name.includes(`${TEST_PREFIX} Conflict`),
      ),
    ).toBe(true);
  });
});

describe('evidence detail and assessment', () => {
  it('returns evidence detail with its exact quotation, source and history', async () => {
    const response = await request('GET', `/api/v1/evidence/${conflict2030Id}`);
    expect(response.statusCode).toBe(200);
    const evidence = response.json().data;
    expect(evidence).toMatchObject({
      id: conflict2030Id,
      productId: conflictProductId,
      claimType: 'support_end',
      rawText: 'Security updates are provided until December 2030.',
      quotedExcerpt: QUOTE_2030,
      dateText: 'December 2030',
      datePrecision: 'month',
      reviewStatus: 'pending',
      source: {
        url: `${BASE}/support/source-2030-${RUN_ID}`,
        domain: HOST,
        title: 'Security update policy 2030',
        httpStatus: 200,
      },
      reviews: [],
    });
  });

  it('returns deterministic assessment checks and failure reasons', async () => {
    const response = await request(
      'GET',
      `/api/v1/products/${conflictProductId}/evidence/assessment`,
    );
    expect(response.statusCode).toBe(200);
    const assessment = response.json().data;

    const valid = assessment.items.find(
      (item: { evidenceId: string }) => item.evidenceId === conflict2030Id,
    );
    expect(valid).toMatchObject({
      sourceIntegrity: { valid: true, reasons: [] },
      quotationIntegrity: { valid: true, reasons: [] },
      claimIntegrity: { valid: true, reasons: [] },
      overallIntegrity: true,
    });

    const thirdParty = assessment.items.find(
      (item: { evidenceId: string }) => item.evidenceId === thirdPartyId,
    );
    expect(thirdParty.sourceIntegrity.valid).toBe(false);
    expect(thirdParty.sourceIntegrity.reasons.join(' ')).toContain(
      'does not match manufacturer website',
    );

    const invalidQuote = assessment.items.find(
      (item: { evidenceId: string }) => item.evidenceId === invalidQuotationId,
    );
    expect(invalidQuote.quotationIntegrity.valid).toBe(false);
  });

  it('returns conflict groups with quotations, dates and source links', async () => {
    const response = await request(
      'GET',
      `/api/v1/products/${conflictProductId}/evidence/assessment`,
    );
    const assessment = response.json().data;
    const group = assessment.detectedConflicts.find(
      (item: { claimType: string }) => item.claimType === 'support_end',
    );

    expect(group).toMatchObject({
      productId: conflictProductId,
      claimType: 'support_end',
      conflictExplanation: expect.stringContaining('December 2030'),
    });
    expect(group.conflictingEvidenceIds.sort()).toEqual(
      [conflict2030Id, conflict2032Id].sort(),
    );
    expect(group.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceId: conflict2030Id,
          quotedExcerpt: QUOTE_2030,
          sourceUrl: `${BASE}/support/source-2030-${RUN_ID}`,
          reviewStatus: 'pending',
        }),
        expect.objectContaining({
          evidenceId: conflict2032Id,
          quotedExcerpt: QUOTE_2032,
          sourceUrl: `${BASE}/support/source-2032-${RUN_ID}`,
          reviewStatus: 'pending',
        }),
      ]),
    );

    const manualIds = assessment.claimsRequiringManualReview.map(
      (item: { evidenceId: string }) => item.evidenceId,
    );
    expect(manualIds).toContain(noDateId);
  });

  it('distinguishes ambiguous date precision from confirmed conflicts', async () => {
    const response = await request(
      'GET',
      `/api/v1/products/${ambiguousProductId}/evidence/assessment`,
    );
    expect(response.statusCode).toBe(200);
    const assessment = response.json().data;
    expect(assessment.detectedConflicts).toHaveLength(0);

    const manualIds = assessment.claimsRequiringManualReview.map(
      (item: { evidenceId: string }) => item.evidenceId,
    );
    expect(manualIds).toContain(ambiguousMonthId);
    expect(manualIds).toContain(ambiguousYearId);
    expect(
      assessment.claimsRequiringManualReview.some((item: { reason: string }) =>
        item.reason.includes('Different date precision'),
      ),
    ).toBe(true);
  });
});

describe('human review decisions and audit history', () => {
  it('rejects invalid decisions and missing or blank review notes', async () => {
    const missing = await review(conflict2030Id, { decision: 'accepted' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const blank = await review(conflict2030Id, { decision: 'accepted', reviewNote: '   ' });
    expect(blank.statusCode).toBe(400);

    const invalid = await review(conflict2030Id, { decision: 'maybe', reviewNote: 'Reviewed.' });
    expect(invalid.statusCode).toBe(400);
  });

  it('rejects acceptance when backend source integrity fails', async () => {
    const response = await review(thirdPartyId, {
      decision: 'accepted',
      reviewNote: 'Attempted acceptance of a third-party source.',
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: 'SOURCE_INTEGRITY_FAILED' },
    });

    const detail = await request('GET', `/api/v1/evidence/${thirdPartyId}`);
    expect(detail.json().data.reviewStatus).toBe('pending');
    expect(detail.json().data.reviews).toHaveLength(0);
  });

  it('accepts evidence and refreshes status, queue counts and review history', async () => {
    const before = await queue(TEST_PREFIX, 'all');
    const beforePending = before.counts.pending;
    const beforeAccepted = before.counts.accepted;

    const response = await review(conflict2030Id, {
      decision: 'accepted',
      reviewNote: 'Checked the quotation against the stored source page.',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.evidence.reviewStatus).toBe('accepted');
    expect(response.json().data.review).toMatchObject({
      decision: 'accepted',
      previousStatus: 'pending',
      reviewNote: 'Checked the quotation against the stored source page.',
    });

    const after = await queue(TEST_PREFIX, 'all');
    expect(after.counts.pending).toBe(beforePending - 1);
    expect(after.counts.accepted).toBe(beforeAccepted + 1);

    const acceptedQueue = await queue(TEST_PREFIX, 'accepted');
    expect(acceptedQueue.data.map((row: { id: string }) => row.id)).toContain(conflict2030Id);

    const detail = await request('GET', `/api/v1/evidence/${conflict2030Id}`);
    expect(detail.json().data.reviews).toHaveLength(1);
    expect(detail.json().data.reviews[0]).toMatchObject({
      decision: 'accepted',
      previousStatus: 'pending',
      reviewNote: 'Checked the quotation against the stored source page.',
    });
  });

  it('keeps accepting an already reviewed record while preserving prior history', async () => {
    const response = await review(conflict2030Id, {
      decision: 'rejected',
      reviewNote: 'Second review found the claim insufficiently scoped.',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.review).toMatchObject({
      decision: 'rejected',
      previousStatus: 'accepted',
    });

    const detail = await request('GET', `/api/v1/evidence/${conflict2030Id}`);
    expect(detail.json().data.reviewStatus).toBe('rejected');
    expect(detail.json().data.reviews).toHaveLength(2);
    expect(detail.json().data.reviews.map((item: { decision: string }) => item.decision)).toEqual([
      'rejected',
      'accepted',
    ]);

    // Restore an accepted claim for the public-information checks below.
    const restore = await review(conflict2030Id, {
      decision: 'accepted',
      reviewNote: 'Reinstated after checking the source quotation again.',
    });
    expect(restore.statusCode).toBe(200);
  });

  it('updates conflict reassessment and public support information after review changes', async () => {
    const conflictingBefore = await request(
      'GET',
      `/api/v1/products/${conflictProductId}/evidence/assessment`,
    );
    expect(
      conflictingBefore
        .json()
        .data.detectedConflicts.some((group: { conflictingEvidenceIds: string[] }) =>
          group.conflictingEvidenceIds.includes(conflict2030Id),
        ),
    ).toBe(true);

    const publicWhileConflicting = await app.inject({
      method: 'GET',
      url: `/api/v1/public/products/${conflictProductId}/support-card`,
    });
    expect(publicWhileConflicting.statusCode).toBe(200);
    expect(publicWhileConflicting.json().data.supportInformation.status).toBe(
      'CONFLICTING_INFORMATION',
    );

    const rejectSecond = await review(conflict2032Id, {
      decision: 'rejected',
      reviewNote: 'The conflicting 2032 statement is not supported by the current policy page.',
    });
    expect(rejectSecond.statusCode).toBe(200);

    const after = await request(
      'GET',
      `/api/v1/products/${conflictProductId}/evidence/assessment`,
    );
    const remainingConflicts = after.json().data.detectedConflicts;
    expect(
      remainingConflicts.some((group: { conflictingEvidenceIds: string[] }) =>
        group.conflictingEvidenceIds.includes(conflict2032Id),
      ),
    ).toBe(false);

    const publicReady = await app.inject({
      method: 'GET',
      url: `/api/v1/public/products/${conflictProductId}/support-card`,
    });
    const support = publicReady.json().data.supportInformation;
    expect(support.status).toBe('INFORMATION_AVAILABLE');
    expect(support.supportEnd).toMatchObject({
      displayValue: 'December 2030',
      precision: 'month',
    });
    expect(support.claims.some((claim: { quotation: string }) => claim.quotation === QUOTE_2030)).toBe(
      true,
    );

    const rejectedQueue = await queue(TEST_PREFIX, 'rejected');
    expect(rejectedQueue.data.map((row: { id: string }) => row.id)).toContain(conflict2032Id);
  });

  it('keeps private review and AI internals out of public support responses', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/public/products/${conflictProductId}/support-card`,
    });
    const serialized = JSON.stringify(response.json());
    expect(serialized).not.toContain('confidence');
    expect(serialized).not.toContain('claimFingerprint');
    expect(serialized).not.toContain('extractionMethod');
    expect(serialized).not.toContain('reviewNote');
    expect(serialized).not.toContain('reviewer');
    expect(serialized).not.toContain('Synthetic review fixture');
  });
});
