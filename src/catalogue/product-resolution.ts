import type { Manufacturer, Product } from '../db/schema.js';
import { normalizeModelIdentifier } from '../lib/normalize.js';
import type { ProductRepository } from '../repositories/product-repository.js';
import type { ValidatedRow } from './row-validator.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ProductCreatedResult {
  outcome: 'created';
  product: Product;
}

export interface ProductDuplicateResult {
  outcome: 'duplicate';
  existingProduct: Product;
  reason: string;
}

export interface ProductConstraintViolationResult {
  outcome: 'constraint_violation';
  message: string;
}

export type ProductResolutionResult =
  | ProductCreatedResult
  | ProductDuplicateResult
  | ProductConstraintViolationResult;

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Attempt to create a product, applying duplicate detection.
 *
 * Priority:
 *   1. manufacturerId + modelIdentifier (case-insensitive after normalisation)
 *   2. manufacturerId + gtin (when modelIdentifier is absent)
 *
 * When no stable identifier exists, we attempt a plain insert. If the database
 * rejects it for any constraint violation we report it as a constraint_violation.
 *
 * NOTE: Without a model identifier or GTIN, reliable cross-import duplicate
 * detection is not possible. The insert will succeed but a future import of
 * the same row will create a second record. This is a known limitation;
 * see docs/catalogue-import.md.
 */
export async function resolveProduct(
  repo: ProductRepository,
  manufacturer: Manufacturer,
  row: ValidatedRow,
): Promise<ProductResolutionResult> {
  const modelIdentifier = row.model_identifier
    ? normalizeModelIdentifier(row.model_identifier)
    : null;

  // --- Priority 1: manufacturer + model identifier ---
  if (modelIdentifier !== null) {
    const existing = await repo.findByManufacturerAndModel(manufacturer.id, modelIdentifier);
    if (existing) {
      return {
        outcome: 'duplicate',
        existingProduct: existing,
        reason: `Product already exists (matched by manufacturer + model identifier "${row.model_identifier ?? ''}")`,
      };
    }
  }

  // --- Priority 2: manufacturer + GTIN (only when no model identifier) ---
  if (modelIdentifier === null && row.gtin) {
    const existing = await repo.findByManufacturerAndGtin(manufacturer.id, row.gtin);
    if (existing) {
      return {
        outcome: 'duplicate',
        existingProduct: existing,
        reason: `Product already exists (matched by manufacturer + GTIN "${row.gtin}")`,
      };
    }
  }

  // --- Create ---
  try {
    const product = await repo.create({
      manufacturerId: manufacturer.id,
      name: row.product_name,
      modelIdentifier: row.model_identifier ?? null,
      gtin: row.gtin ?? null,
      sku: row.sku ?? null,
      category: row.category ?? null,
      productUrl: row.product_url ?? null,
      marketRegion: row.market_region ?? null,
    });
    return { outcome: 'created', product };
  } catch (err) {
    // Surface database constraint violations without rolling back sibling rows.
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: 'constraint_violation', message: msg };
  }
}
