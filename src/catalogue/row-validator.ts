import { z } from 'zod';
import { isValidGtin } from '../lib/gtin.js';
import type { ParsedCsvRow } from './csv-parser.js';

// ---------------------------------------------------------------------------
// Helpers for optional nullable fields
// ---------------------------------------------------------------------------

/** Treat empty / blank strings as null. */
function optionalNullableString() {
  return z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? null : v.trim()));
}

function optionalNullableUrl() {
  return z
    .string()
    .optional()
    .transform((v): string | null => (v === undefined || v.trim() === '' ? null : v.trim()))
    .pipe(
      z.union([
        z.null(),
        z
          .string()
          .url('Must be a valid HTTP or HTTPS URL')
          .refine(
            (v) => v.startsWith('http://') || v.startsWith('https://'),
            'Must be a valid HTTP or HTTPS URL',
          ),
      ]),
    );
}

// ---------------------------------------------------------------------------
// Row schema
// ---------------------------------------------------------------------------

const rowSchema = z.object({
  manufacturer_name: z
    .string({ error: 'manufacturer_name is required' })
    .min(1, 'manufacturer_name cannot be empty')
    .transform((v) => v.trim()),

  product_name: z
    .string({ error: 'product_name is required' })
    .min(1, 'product_name cannot be empty')
    .transform((v) => v.trim()),

  manufacturer_website: optionalNullableUrl(),

  manufacturer_country_code: z
    .string()
    .optional()
    .transform((v): string | null => (v === undefined || v.trim() === '' ? null : v.trim()))
    .pipe(
      z.union([
        z.null(),
        z
          .string()
          .regex(/^[A-Za-z]{2}$/, 'Country code must be a two-letter ISO 3166-1 alpha-2 code')
          .transform((v) => v.toUpperCase()),
      ]),
    ),

  model_identifier: optionalNullableString(),

  gtin: z
    .string()
    .optional()
    .transform((v): string | null => (v === undefined || v.trim() === '' ? null : v.trim()))
    .pipe(
      z.union([
        z.null(),
        z
          .string()
          .refine((v) => /^\d+$/.test(v), 'GTIN must contain only digits')
          .refine(
            (v) => [8, 12, 13, 14].includes(v.length),
            'GTIN must be 8, 12, 13, or 14 digits',
          )
          .refine((v) => isValidGtin(v), 'Invalid GTIN check digit'),
      ]),
    ),

  sku: optionalNullableString(),
  category: optionalNullableString(),
  product_url: optionalNullableUrl(),
  market_region: optionalNullableString(),
});

// ---------------------------------------------------------------------------
// Validated row type
// ---------------------------------------------------------------------------

export type ValidatedRow = z.infer<typeof rowSchema>;

// ---------------------------------------------------------------------------
// Validation result types
// ---------------------------------------------------------------------------

export interface RowValidationSuccess {
  ok: true;
  data: ValidatedRow;
}

export interface RowValidationFailure {
  ok: false;
  errors: Array<{ field: string; message: string }>;
}

export type RowValidationResult = RowValidationSuccess | RowValidationFailure;

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validate a single parsed CSV row.
 *
 * Required fields that are missing or blank produce field-level errors.
 * Optional fields that are blank are coerced to null.
 */
export function validateRow(row: ParsedCsvRow): RowValidationResult {
  const input = {
    manufacturer_name: row.fields.manufacturer_name,
    product_name: row.fields.product_name,
    manufacturer_website: row.fields.manufacturer_website,
    manufacturer_country_code: row.fields.manufacturer_country_code,
    model_identifier: row.fields.model_identifier,
    gtin: row.fields.gtin,
    sku: row.fields.sku,
    category: row.fields.category,
    product_url: row.fields.product_url,
    market_region: row.fields.market_region,
  };

  const result = rowSchema.safeParse(input);

  if (result.success) {
    return { ok: true, data: result.data };
  }

  const errors = result.error.issues.map((issue) => ({
    field: issue.path.map(String).join('.') || 'unknown',
    message: issue.message,
  }));

  return { ok: false, errors };
}

