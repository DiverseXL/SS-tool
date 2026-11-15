import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { closeDatabase, createDatabase, type Database } from '../src/db/client.js';
import { authHeaders, login, TEST_AUTH } from './helpers/test-auth.js';

// Every record this suite creates is namespaced with this prefix, so cleanup
// can never touch data that existed before the run.
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_PREFIX = `Step2 Test ${RUN_ID}`;

let app: FastifyInstance;
let database: Database;

function testName(label: string): string {
  return `${TEST_PREFIX} ${label}`;
}

function post(url: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url,
    payload: payload as object,
    headers: authHeaders(app),
  });
}

function get(url: string) {
  return app.inject({ method: 'GET', url, headers: authHeaders(app) });
}

/** Builds a valid GTIN-14 while preserving the leading zero in `data`. */
function gtin14(data: string): string {
  let sum = 0;
  for (let i = data.length - 1, weight = 3; i >= 0; i -= 1, weight = weight === 3 ? 1 : 3) {
    sum += Number(data[i]) * weight;
  }
  return `${data}${(10 - (sum % 10)) % 10}`;
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

    // Evidence references products with ON DELETE CASCADE and sources with
    // ON DELETE RESTRICT, so products go first, then manufacturers and sources.
    await database.client`
      delete from products
      where manufacturer_id in (
        select id from manufacturers where normalized_name like ${likePattern}
      )
    `;
    await database.client`delete from manufacturers where normalized_name like ${likePattern}`;
    await database.client`delete from sources where url like ${`https://example.test/${RUN_ID}%`}`;
  }

  await app?.close();
  if (database) await closeDatabase(database);
});

describe('POST /api/v1/manufacturers', () => {
  it('creates a manufacturer with a normalized name and uppercase country code', async () => {
    const response = await post('/api/v1/manufacturers', {
      name: `  ${testName('Acme   Electronics')}  `,
      website: 'https://acme.example',
      countryCode: 'de',
    });

    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(body.data).toMatchObject({
      name: testName('Acme   Electronics'),
      normalizedName: testName('Acme Electronics').toLowerCase(),
      website: 'https://acme.example',
      countryCode: 'DE',
    });
    expect(body.data.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.data.createdAt).toEqual(expect.any(String));
  });

  it('rejects a malformed website URL', async () => {
    const response = await post('/api/v1/manufacturers', {
      name: testName('Bad Website'),
      website: 'not-a-url',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(response.json().error.details).toContainEqual(
      expect.objectContaining({ path: 'website' }),
    );
  });

  it('returns 409 for a duplicate name regardless of case and spacing', async () => {
    const name = testName('Duplicate Co');
    const first = await post('/api/v1/manufacturers', { name });
    expect(first.statusCode).toBe(201);

    const second = await post('/api/v1/manufacturers', { name: `  ${name.toUpperCase()}  ` });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: 'DUPLICATE_MANUFACTURER' } });
  });
});

describe('GET /api/v1/manufacturers', () => {
  it('retrieves a manufacturer by id and includes it in the list', async () => {
    const created = await post('/api/v1/manufacturers', { name: testName('Retrievable') });
    expect(created.statusCode).toBe(201);
    const { id } = created.json().data;

    const detail = await get(`/api/v1/manufacturers/${id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ data: { id, name: testName('Retrievable') } });

    const list = await get('/api/v1/manufacturers');
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toContainEqual(expect.objectContaining({ id }));
  });

  it('returns 404 for an unknown manufacturer id', async () => {
    const response = await get('/api/v1/manufacturers/00000000-0000-4000-8000-000000000000');

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'MANUFACTURER_NOT_FOUND' } });
  });
});

describe('POST /api/v1/products', () => {
  let manufacturerId: string;

  beforeAll(async () => {
    const created = await post('/api/v1/manufacturers', { name: testName('Product Maker') });
    manufacturerId = created.json().data.id;
  });

  it('creates a product and preserves a leading zero in the GTIN', async () => {
    const gtin = gtin14('0123456789012'); // 14 digits, starts with 0

    const response = await post('/api/v1/products', {
      manufacturerId,
      name: testName('Washer 1000'),
      modelIdentifier: 'WASH-1000',
      gtin,
      sku: 'SKU-001',
      category: 'washing machine',
      productUrl: 'https://acme.example/wash-1000',
      marketRegion: 'DE',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      manufacturerId,
      name: testName('Washer 1000'),
      modelIdentifier: 'WASH-1000',
      gtin,
      sku: 'SKU-001',
      category: 'washing machine',
      productUrl: 'https://acme.example/wash-1000',
      marketRegion: 'DE',
    });
    expect(response.json().data.gtin).toBe(gtin);
    expect(response.json().data.gtin.startsWith('0')).toBe(true);
  });

  it('returns 404 when the manufacturer does not exist', async () => {
    const response = await post('/api/v1/products', {
      manufacturerId: '00000000-0000-4000-8000-000000000000',
      name: testName('Orphan'),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'MANUFACTURER_NOT_FOUND' } });
  });

  it('rejects invalid product input', async () => {
    const missingName = await post('/api/v1/products', { manufacturerId });
    expect(missingName.statusCode).toBe(400);
    expect(missingName.json().error.details).toContainEqual(
      expect.objectContaining({ path: 'name' }),
    );

    const badUrl = await post('/api/v1/products', {
      manufacturerId,
      name: testName('Bad URL'),
      productUrl: 'javascript:alert(1)',
    });
    expect(badUrl.statusCode).toBe(400);
    expect(badUrl.json().error.details).toContainEqual(
      expect.objectContaining({ path: 'productUrl' }),
    );
  });

  it('rejects malformed GTIN values', async () => {
    const badCheckDigit = await post('/api/v1/products', {
      manufacturerId,
      name: testName('Bad GTIN checksum'),
      gtin: '1234567890123',
    });
    expect(badCheckDigit.statusCode).toBe(400);
    expect(badCheckDigit.json().error.details).toContainEqual(
      expect.objectContaining({ path: 'gtin' }),
    );

    const badLength = await post('/api/v1/products', {
      manufacturerId,
      name: testName('Bad GTIN length'),
      gtin: '12345',
    });
    expect(badLength.statusCode).toBe(400);
  });

  it('returns 409 for a duplicate manufacturer/model identifier', async () => {
    const payload = {
      manufacturerId,
      name: testName('Dupe Model'),
      modelIdentifier: 'DUP-MODEL-1',
    };

    const first = await post('/api/v1/products', payload);
    expect(first.statusCode).toBe(201);

    const second = await post('/api/v1/products', {
      ...payload,
      name: testName('Dupe Model'),
      modelIdentifier: 'dup-model-1',
    });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: 'DUPLICATE_PRODUCT' } });
  });
});

describe('GET /api/v1/products', () => {
  let manufacturerA: string;
  let manufacturerB: string;

  beforeAll(async () => {
    const a = await post('/api/v1/manufacturers', { name: testName('Lister A') });
    const b = await post('/api/v1/manufacturers', { name: testName('Lister B') });
    manufacturerA = a.json().data.id;
    manufacturerB = b.json().data.id;

    for (const index of [1, 2, 3]) {
      const response = await post('/api/v1/products', {
        manufacturerId: manufacturerA,
        name: testName(`Listed ${index}`),
        modelIdentifier: `LIST-A-${index}`,
      });
      expect(response.statusCode).toBe(201);
    }

    const other = await post('/api/v1/products', {
      manufacturerId: manufacturerB,
      name: testName('Listed B'),
      modelIdentifier: 'LIST-B-1',
    });
    expect(other.statusCode).toBe(201);
  });

  it('paginates products with stable page metadata', async () => {
    const firstPage = await get('/api/v1/products?page=1&pageSize=2');

    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().data).toHaveLength(2);
    expect(firstPage.json().pagination).toMatchObject({
      page: 1,
      pageSize: 2,
      totalPages: expect.any(Number),
    });
    expect(firstPage.json().pagination.total).toBeGreaterThanOrEqual(4);

    const secondPage = await get('/api/v1/products?page=2&pageSize=2');
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json().data).toHaveLength(2);

    const firstIds = firstPage.json().data.map((product: { id: string }) => product.id);
    const secondIds = secondPage.json().data.map((product: { id: string }) => product.id);
    expect(firstIds).not.toEqual(expect.arrayContaining(secondIds));
  });

  it('filters products by manufacturer', async () => {
    const response = await get(`/api/v1/products?manufacturerId=${manufacturerA}&pageSize=100`);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pagination.total).toBe(3);
    expect(body.data).toHaveLength(3);
    expect(
      body.data.every((product: { manufacturerId: string }) => product.manufacturerId === manufacturerA),
    ).toBe(true);
  });

  it('retrieves product detail with its manufacturer', async () => {
    const list = await get(`/api/v1/products?manufacturerId=${manufacturerB}&pageSize=100`);
    const { id } = list.json().data[0];

    const response = await get(`/api/v1/products/${id}`);

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      id,
      manufacturerId: manufacturerB,
      manufacturer: {
        id: manufacturerB,
        name: testName('Lister B'),
      },
    });
  });

  it('returns 404 for an unknown product and 400 for a malformed id', async () => {
    const unknown = await get('/api/v1/products/00000000-0000-4000-8000-000000000000');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { code: 'PRODUCT_NOT_FOUND' } });

    const malformed = await get('/api/v1/products/not-a-uuid');
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('rejects invalid pagination parameters', async () => {
    const response = await get('/api/v1/products?page=0&pageSize=500');

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});

describe('database integrity', () => {
  it('enforces foreign keys and cascade/restrict deletion behaviour', async () => {
    const manufacturer = await post('/api/v1/manufacturers', { name: testName('FK Maker') });
    const manufacturerId = manufacturer.json().data.id;

    const product = await post('/api/v1/products', {
      manufacturerId,
      name: testName('FK Product'),
    });
    const productId = product.json().data.id;

    // A product cannot reference a manufacturer that does not exist.
    await expect(
      database.client`
        insert into products (manufacturer_id, name)
        values ('00000000-0000-4000-8000-000000000000', 'orphan')
      `,
    ).rejects.toMatchObject({ code: '23503' });

    // A manufacturer with products cannot be deleted.
    await expect(
      database.client`delete from manufacturers where id = ${manufacturerId}`,
    ).rejects.toMatchObject({ code: '23503' });

    const sourceUrl = `https://example.test/${RUN_ID}/fk-source`;
    const [source] = await database.client`
      insert into sources (url, domain) values (${sourceUrl}, 'example.test') returning id
    `;
    if (!source) throw new Error('source insert returned no row');

    const [evidenceRow] = await database.client`
      insert into evidence
        (product_id, source_id, claim_type, raw_text, quoted_excerpt, extraction_method, confidence, normalized_date)
      values
        (${productId}, ${source.id}, 'support_end', 'Support ends 2027-12-31', 'Support ends 2027-12-31', 'manual', 0.9, '2027-12-31')
      returning review_status, normalized_date, confidence
    `;

    // Evidence starts unreviewed and never invents a missing date.
    expect(evidenceRow).toMatchObject({
      review_status: 'pending',
      normalized_date: '2027-12-31',
      confidence: '0.900',
    });

    // A cited source cannot be deleted.
    await expect(
      database.client`delete from sources where id = ${source.id}`,
    ).rejects.toMatchObject({ code: '23503' });

    // Deleting the product cascades to its evidence.
    await database.client`delete from products where id = ${productId}`;
    const remaining = await database.client`
      select count(*)::int as count from evidence where source_id = ${source.id}
    `;
    expect(remaining[0]?.count).toBe(0);

    // Confidence outside 0..1 is rejected.
    const product2 = await post('/api/v1/products', {
      manufacturerId,
      name: testName('FK Product 2'),
    });
    const product2Id = product2.json().data.id;

    await expect(
      database.client`
        insert into evidence
          (product_id, source_id, claim_type, raw_text, quoted_excerpt, extraction_method, confidence)
        values
          (${product2Id}, ${source.id}, 'policy', 'raw', 'raw', 'manual', 1.5)
      `,
    ).rejects.toMatchObject({ code: '23514' });

    // Cleaning up this test's own records; the source is now unreferenced.
    await database.client`delete from products where manufacturer_id = ${manufacturerId}`;
    await database.client`delete from sources where id = ${source.id}`;
    await database.client`delete from manufacturers where id = ${manufacturerId}`;
  });
});
