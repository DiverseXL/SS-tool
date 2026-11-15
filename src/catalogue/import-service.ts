import type { ManufacturerRepository } from '../repositories/manufacturer-repository.js';
import type { ProductRepository } from '../repositories/product-repository.js';
import { parseCsv } from './csv-parser.js';
import { validateRow } from './row-validator.js';
import { resolveManufacturer } from './manufacturer-resolution.js';
import { resolveProduct } from './product-resolution.js';
import type {
  ImportResponse,
  RowResult,
} from './import-response.js';

/**
 * Process a raw CSV buffer through the full import pipeline:
 *
 *   parse → validate → resolve manufacturer → resolve/create product
 *
 * Each row is processed independently so a failure in one row does not
 * affect the others.
 */
export async function importCatalogueFromBuffer(
  manufacturerRepo: ManufacturerRepository,
  productRepo: ProductRepository,
  buffer: Buffer,
): Promise<ImportResponse> {
  // 1. Parse CSV structure.
  const { rows: parsedRows, ignoredColumns } = parseCsv(buffer);

  const results: RowResult[] = [];
  const allWarnings: string[] = [];

  let created = 0;
  let duplicates = 0;
  let failed = 0;

  // 2. Process each row independently.
  for (const parsedRow of parsedRows) {
    // 2a. Validate.
    const validation = validateRow(parsedRow);
    if (!validation.ok) {
      results.push({ row: parsedRow.rowNumber, status: 'rejected', errors: validation.errors });
      failed++;
      continue;
    }

    const rowData = validation.data;

    // 2b. Resolve manufacturer.
    let manufacturerResult: Awaited<ReturnType<typeof resolveManufacturer>>;
    try {
      manufacturerResult = await resolveManufacturer(manufacturerRepo, rowData);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        row: parsedRow.rowNumber,
        status: 'rejected',
        errors: [{ field: 'manufacturer_name', message: `Manufacturer error: ${message}` }],
      });
      failed++;
      continue;
    }

    if (manufacturerResult.warnings.length > 0) {
      allWarnings.push(
        ...manufacturerResult.warnings.map((w) => `Row ${parsedRow.rowNumber}: ${w}`),
      );
    }

    // 2c. Resolve / create product.
    const productResult = await resolveProduct(productRepo, manufacturerResult.manufacturer, rowData);

    switch (productResult.outcome) {
      case 'created':
        results.push({
          row: parsedRow.rowNumber,
          status: 'created',
          productId: productResult.product.id,
        });
        created++;
        break;

      case 'duplicate':
        results.push({
          row: parsedRow.rowNumber,
          status: 'duplicate',
          reason: productResult.reason,
        });
        duplicates++;
        break;

      case 'constraint_violation':
        results.push({
          row: parsedRow.rowNumber,
          status: 'rejected',
          errors: [{ field: 'product', message: productResult.message }],
        });
        failed++;
        break;
    }
  }

  return {
    summary: {
      totalRows: parsedRows.length,
      created,
      duplicates,
      failed,
    },
    results,
    ignoredColumns,
    warnings: allWarnings,
  };
}

