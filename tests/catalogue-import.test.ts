/**
 * Integration tests for POST /api/v1/catalogue/imports
 *
 * These tests run against the real PostgreSQL database (DATABASE_URL from .env).
 * They do NOT reset unrelated tables. Each test uses unique manufacturer names
 * and model identifiers to prevent cross-test interference.
 */

import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import FormData from 'form-data';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { closeDatabase, createDatabase } from '../src/db/client.js';
import postgres from 'postgres';
import { manufacturers, products } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { login, TEST_AUTH } from './helpers/test-auth.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const env = loadEnv();
const database = createDatabase(env.DATABASE_URL);
const app = buildApp({ database, logger: false, auth: TEST_AUTH });
const sessionCookie = app.ready().then(() => login(app));

afterAll(async () => {
  await app.close();
  await closeDatabase(database);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a unique suffix to isolate test data. */
function uid(): string {
  return randomBytes(4).toString('hex');
}

/** Build a minimal valid CSV from an array of rows. */
function buildCsv(rows: string[], extraHeaders = ''): string {
  const headers = `manufacturer_name,manufacturer_website,manufacturer_country_code,product_name,model_identifier,gtin,sku,category,product_url,market_region${extraHeaders ? ',' + extraHeaders : ''}`;
  return [headers, ...rows].join('\n');
}

/** Inject a multipart request into the Fastify app under test. */
async function uploadCsv(csvContent: string | Buffer, fieldName = 'file') {
  const form = new FormData();
  form.append(fieldName, csvContent instanceof Buffer ? csvContent : Buffer.from(csvContent), {
    filename: 'catalogue.csv',
    contentType: 'text/csv',
  });

  const headers = form.getHeaders() as Record<string, string>;
  headers.cookie = await sessionCookie;

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/catalogue/imports',
    headers,
    payload: form.getBuffer(),
  });

  return response;
}

// Known valid GTINs (GS1 check-digit verified).
function makeGtin12LeadingZero(): string { return '012345678905'; }
function makeGtin8(): string { return '06141417'; }

// ---------------------------------------------------------------------------
// 1. Valid CSV containing multiple products
// ---------------------------------------------------------------------------
describe('valid CSV with multiple products', () => {
  it('creates all valid products and returns HTTP 200', async () => {
    const id = uid();
    const csv = buildCsv([
      `Mfr ${id},https://mfr${id}.example.com,US,Product Alpha,MDL-${id}-A,,,,,`,
      `Mfr ${id},https://mfr${id}.example.com,US,Product Beta,MDL-${id}-B,,,,,`,
    ]);

    const res = await uploadCsv(csv);
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      summary: { created: number; totalRows: number; failed: number };
    };
    expect(body.summary.totalRows).toBe(2);
    expect(body.summary.created).toBe(2);
    expect(body.summary.failed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Creating a manufacturer automatically
// ---------------------------------------------------------------------------
describe('manufacturer auto-creation', () => {
  it('creates a new manufacturer when it does not exist', async () => {
    const id = uid();
    const csv = buildCsv([
      `AutoMfr ${id},,US,Some Product,AMP-${id},,,,,`,
    ]);

    const res = await uploadCsv(csv);
    expect(res.statusCode).toBe(200);

    const body = res.json() as { summary: { created: number } };
    expect(body.summary.created).toBe(1);

    // Confirm the manufacturer exists in the database.
    const rows = await database.orm
      .select()
      .from(manufacturers)
      .where(eq(manufacturers.normalizedName, `automfr ${id}`));
    expect(rows.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Reusing an existing manufacturer
// ---------------------------------------------------------------------------
describe('manufacturer reuse', () => {
  it('does not create a duplicate manufacturer for the same name', async () => {
    const id = uid();
    const csv = buildCsv([
      `SharedMfr ${id},,DE,Product One,SMP-${id}-1,,,,,`,
      `SharedMfr ${id},,DE,Product Two,SMP-${id}-2,,,,,`,
    ]);

    const res = await uploadCsv(csv);
    expect(res.statusCode).toBe(200);

    const rows = await database.orm
      .select()
      .from(manufacturers)
      .where(eq(manufacturers.normalizedName, `sharedmfr ${id}`));
    // Exactly one manufacturer record.
    expect(rows.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Two products from the same manufacturer
// ---------------------------------------------------------------------------
describe('two products from the same manufacturer', () => {
  it('creates both products linked to the same manufacturer', async () => {
    const id = uid();
    const csv = buildCsv([
      `DualMfr ${id},,JP,Alpha Widget,DW-${id}-A,,,,,`,
      `DualMfr ${id},,JP,Beta Widget,DW-${id}-B,,,,,`,
    ]);

    const res = await uploadCsv(csv);
    const body = res.json() as {
      summary: { created: number };
      results: Array<{ status: string; productId?: string }>;
    };

    expect(res.statusCode).toBe(200);
    expect(body.summary.created).toBe(2);

    const createdIds = body.results
      .filter((r) => r.status === 'created')
      .map((r) => r.productId as string);
    expect(createdIds.length).toBe(2);

    // Both products belong to the same manufacturer.
    const productRows = await database.orm
      .select()
      .from(products)
      .where(eq(products.id, createdIds[0]!));
    const productRows2 = await database.orm
      .select()
      .from(products)
      .where(eq(products.id, createdIds[1]!));

    expect(productRows[0]?.manufacturerId).toBe(productRows2[0]?.manufacturerId);
  });
});

// ---------------------------------------------------------------------------
// 5. UTF-8 BOM handling
// ---------------------------------------------------------------------------
describe('UTF-8 BOM', () => {
  it('strips the BOM and parses correctly', async () => {
    const id = uid();
    const csvContent = `manufacturer_name,product_name,model_identifier\nBomMfr ${id},BOM Product,BOM-${id}`;
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const buffer = Buffer.concat([bom, Buffer.from(csvContent, 'utf8')]);

    const res = await uploadCsv(buffer);
    expect(res.statusCode).toBe(200);

    const body = res.json() as { summary: { created: number } };
    expect(body.summary.created).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Quoted fields containing commas
// ---------------------------------------------------------------------------
describe('quoted fields with commas', () => {
  it('parses product names and manufacturer names containing commas', async () => {
    const id = uid();
    const csv = `manufacturer_name,product_name,model_identifier\n"Widgets, Inc. ${id}","Super, Duper Widget",QFC-${id}`;

    const res = await uploadCsv(csv);
    expect(res.statusCode).toBe(200);

    const body = res.json() as { summary: { created: number } };
    expect(body.summary.created).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Missing required headers
// ---------------------------------------------------------------------------
describe('missing required headers', () => {
  it('returns 422 when manufacturer_name header is absent', async () => {
    const csv = `product_name,model_identifier\nSome Product,MDL-001`;
    const res = await uploadCsv(csv);
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('MISSING_REQUIRED_HEADERS');
  });

  it('returns 422 when product_name header is absent', async () => {
    const csv = `manufacturer_name,model_identifier\nAcme,MDL-001`;
    const res = await uploadCsv(csv);
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('MISSING_REQUIRED_HEADERS');
  });
});

// ---------------------------------------------------------------------------
// 8. Empty manufacturer name
// ---------------------------------------------------------------------------
describe('empty manufacturer name', () => {
  it('rejects the row but does not fail other rows', async () => {
    const id = uid();
    const csv = buildCsv([
      `,,,NoMfr Product,NMP-${id},,,,,`,
      `ValidMfr ${id},,,Valid Product,VMP-${id},,,,,`,
    ]);

    const res = await uploadCsv(csv);
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      summary: { created: number; failed: number };
      results: Array<{ status: string; row: number }>;
    };
    expect(body.summary.created).toBe(1);
    expect(body.summary.failed).toBe(1);
    expect(body.results.find((r) => r.row === 2)?.status).toBe('rejected');
    expect(body.results.find((r) => r.row === 3)?.status).toBe('created');
  });
});

// ---------------------------------------------------------------------------
// 9. Empty product name
// ---------------------------------------------------------------------------
describe('empty product name', () => {
  it('rejects the row with a field-level error', async () => {
    const id = uid();
    const csv = buildCsv([`EmptyProd ${id},,,,,,,,,`]);

    const res = await uploadCsv(csv);
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      results: Array<{ status: string; errors?: Array<{ field: string }> }>;
    };
    const row = body.results[0];
    expect(row?.status).toBe('rejected');
    expect(row?.errors?.some((e) => e.field === 'product_name')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. Invalid product URL
// ---------------------------------------------------------------------------
describe('invalid product URL', () => {
  it('rejects a row with a non-HTTP product_url', async () => {
    const id = uid();
    const csv = buildCsv([
      `UrlMfr ${id},,,Bad URL Product,BUP-${id},,,,not-a-url,`,
    ]);

    const res = await uploadCsv(csv);
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      results: Array<{ status: string; errors?: Array<{ field: string }> }>;
    };
    const row = body.results[0];
    expect(row?.status).toBe('rejected');
    expect(row?.errors?.some((e) => e.field === 'product_url')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. Invalid GTIN
// ---------------------------------------------------------------------------
describe('invalid GTIN', () => {
  it('rejects a row with a GTIN that has a wrong check digit', async () => {
    const id = uid();
    // 00000123456789 has wrong check digit (should be 4)
    const csv = buildCsv([
      `GtinMfr ${id},,,Bad GTIN Product,BGP-${id},00000123456789,,,`,
    ]);

    const res = await uploadCsv(csv);
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      results: Array<{ status: string; errors?: Array<{ field: string; message: string }> }>;
    };
    const row = body.results[0];
    expect(row?.status).toBe('rejected');
    expect(row?.errors?.some((e) => e.field === 'gtin')).toBe(true);
  });

  it('rejects a GTIN with invalid length', async () => {
    const id = uid();
    const csv = buildCsv([
      `GtinMfr2 ${id},,,Bad Len Product,BLP-${id},123456789,,,`,
    ]);

    const res = await uploadCsv(csv);
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      results: Array<{ status: string; errors?: Array<{ field: string }> }>;
    };
    const row = body.results[0];
    expect(row?.status).toBe('rejected');
    expect(row?.errors?.some((e) => e.field === 'gtin')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 12. Valid GTIN with leading zeros
// ---------------------------------------------------------------------------
describe('valid GTIN with leading zeros', () => {
  it('preserves leading zeros in a valid GTIN-12', async () => {
    const id = uid();
    const gtin = makeGtin12LeadingZero(); // 012345678905
    const csv = buildCsv([
      `LeadZeroMfr ${id},,,LeadZero Product,LZP-${id},${gtin},,,`,
    ]);

    const res = await uploadCsv(csv);
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      summary: { created: number };
      results: Array<{ status: string; productId?: string }>;
    };
    expect(body.summary.created).toBe(1);

    // Verify leading zero was preserved in the database.
    const productId = body.results[0]?.productId;
    if (productId) {
      const rows = await database.orm
        .select()
        .from(products)
        .where(eq(products.id, productId));
      expect(rows[0]?.gtin).toBe(gtin);
    }
  });
});

// ---------------------------------------------------------------------------
// 13. Duplicate model identifier
// ---------------------------------------------------------------------------
describe('duplicate model identifier', () => {
  it('reports the second occurrence as a duplicate', async () => {
    const id = uid();
    const csv = buildCsv([
      `DupMfr ${id},,,Product Original,DUP-${id},,,,,`,
      `DupMfr ${id},,,Product Copy,DUP-${id},,,,,`,
    ]);

    const res = await uploadCsv(csv);
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      summary: { created: number; duplicates: number };
      results: Array<{ status: string; row: number }>;
    };
    expect(body.summary.created).toBe(1);
    expect(body.summary.duplicates).toBe(1);
    expect(body.results.find((r) => r.row === 2)?.status).toBe('created');
    expect(body.results.find((r) => r.row === 3)?.status).toBe('duplicate');
  });

  it('compares model identifiers case-insensitively', async () => {
    const id = uid();
    const csv = buildCsv([
      `CaseMfr ${id},,,Original Product,CASE-${id},,,,,`,
      `CaseMfr ${id},,,Same Product lowercase,case-${id},,,,,`,
    ]);

    const res = await uploadCsv(csv);
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      summary: { created: number; duplicates: number };
    };
    expect(body.summary.created).toBe(1);
    expect(body.summary.duplicates).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 14. Duplicate GTIN (no model identifier)
// ---------------------------------------------------------------------------
describe('duplicate GTIN without model identifier', () => {
  it('detects a duplicate by manufacturer + GTIN when model_identifier is absent', async () => {
    const id = uid();
    const gtin = makeGtin8(); // 06141417
    const csv = buildCsv([
      `GtinDupMfr ${id},,,GTIN Product One,,${gtin},,,`,
      `GtinDupMfr ${id},,,GTIN Product Two,,${gtin},,,`,
    ]);

    const res = await uploadCsv(csv);
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      summary: { created: number; duplicates: number };
    };
    expect(body.summary.created).toBe(1);
    expect(body.summary.duplicates).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 15. Partial success when one row is invalid
// ---------------------------------------------------------------------------
describe('partial success', () => {
  it('processes valid rows even when one row is invalid', async () => {
    const id = uid();
    const csv = buildCsv([
      `PartMfr ${id},,,Valid Product,PRT-${id}-OK,,,,,`,
      `,,,Invalid (no mfr),,,,,,`,
      `PartMfr ${id},,,Another Valid,PRT-${id}-OK2,,,,,`,
    ]);

    const res = await uploadCsv(csv);
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      summary: { totalRows: number; created: number; failed: number };
      results: Array<{ status: string; row: number }>;
    };
    expect(body.summary.totalRows).toBe(3);
    expect(body.summary.created).toBe(2);
    expect(body.summary.failed).toBe(1);
    expect(body.results.find((r) => r.row === 3)?.status).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// 16. File size limit
// ---------------------------------------------------------------------------
describe('file size limit', () => {
  it('returns 413 when the upload exceeds 5 MB', async () => {
    // Generate a CSV that is just over 5 MB.
    const header = 'manufacturer_name,product_name\n';
    // Each row is ~50 bytes; 110 000 rows ≈ 5.5 MB
    const row = 'A'.repeat(40) + ',Product\n';
    const bigCsv = header + row.repeat(110_000);

    const res = await uploadCsv(bigCsv);
    expect(res.statusCode).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// 17. Row limit (500 rows)
// ---------------------------------------------------------------------------
describe('row limit', () => {
  it('returns 422 when the CSV has more than 500 data rows', async () => {
    const header = 'manufacturer_name,product_name,model_identifier\n';
    const rows = Array.from(
      { length: 501 },
      (_, i) => `Mfr Row,Product ${i},MDL-ROW-${i}`,
    ).join('\n');
    const csv = header + rows;

    const res = await uploadCsv(csv);
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_CSV');
  });
});

// ---------------------------------------------------------------------------
// 18. Manufacturer metadata conflicts
// ---------------------------------------------------------------------------
describe('manufacturer metadata conflicts', () => {
  it('warns without overwriting existing metadata', async () => {
    const id = uid();
    // First import sets website.
    const csv1 = buildCsv([
      `ConflictMfr ${id},https://original.example.com,US,Product One,CONF-${id}-1,,,,,`,
    ]);
    await uploadCsv(csv1);

    // Second import supplies a different website.
    const csv2 = buildCsv([
      `ConflictMfr ${id},https://different.example.com,US,Product Two,CONF-${id}-2,,,,,`,
    ]);
    const res = await uploadCsv(csv2);
    expect(res.statusCode).toBe(200);

    const body = res.json() as { warnings: string[] };
    expect(body.warnings.some((w) => w.includes('website'))).toBe(true);

    // Verify original website was not overwritten.
    const rows = await database.orm
      .select()
      .from(manufacturers)
      .where(eq(manufacturers.normalizedName, `conflictmfr ${id}`));
    expect(rows[0]?.website).toBe('https://original.example.com');
  });
});

// ---------------------------------------------------------------------------
// 19. Unknown / unsupported columns
// ---------------------------------------------------------------------------
describe('unknown columns', () => {
  it('ignores unknown columns and reports them', async () => {
    const id = uid();
    const csv = `manufacturer_name,product_name,model_identifier,unknown_col_xyz\nIgnMfr ${id},Ign Product,IGN-${id},mystery_value`;

    const res = await uploadCsv(csv);
    expect(res.statusCode).toBe(200);

    const body = res.json() as { summary: { created: number }; ignoredColumns: string[] };
    expect(body.summary.created).toBe(1);
    expect(body.ignoredColumns).toContain('unknown_col_xyz');
  });
});

// ---------------------------------------------------------------------------
// 20. No evidence records are created
// ---------------------------------------------------------------------------
describe('data integrity — no evidence records', () => {
  it('does not create any evidence records during import', async () => {
    const id = uid();
    const csv = buildCsv([
      `EvidMfr ${id},https://evid.example.com,US,Evidence Check Product,ECP-${id},,,,,`,
    ]);

    const res = await uploadCsv(csv);
    expect(res.statusCode).toBe(200);

    const body = res.json() as { summary: { created: number }; results: Array<{ productId?: string }> };
    const productId = body.results[0]?.productId;
    expect(productId).toBeDefined();

    // Verify in database that 0 evidence records were created for this product
    const dbClient = postgres(env.DATABASE_URL, { max: 1 });
    try {
      const evidenceRows = await dbClient`
        SELECT count(*)::int as count FROM evidence WHERE product_id = ${productId!}
      `;
      expect(evidenceRows[0]?.count).toBe(0);
    } finally {
      await dbClient.end();
    }
  });
});
