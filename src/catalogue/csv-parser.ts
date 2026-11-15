import { parse } from 'csv-parse/sync';

// ---------------------------------------------------------------------------
// Canonical headers
// ---------------------------------------------------------------------------

export const REQUIRED_HEADERS = ['manufacturer_name', 'product_name'] as const;

export const OPTIONAL_HEADERS = [
  'manufacturer_website',
  'manufacturer_country_code',
  'model_identifier',
  'gtin',
  'sku',
  'category',
  'product_url',
  'market_region',
] as const;

export const ALL_KNOWN_HEADERS = [...REQUIRED_HEADERS, ...OPTIONAL_HEADERS] as const;
export type KnownHeader = (typeof ALL_KNOWN_HEADERS)[number];

// ---------------------------------------------------------------------------
// Header normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a raw header token from the CSV file:
 *   - trim surrounding whitespace
 *   - lower-case
 *   - replace spaces and hyphens with underscores
 */
export function normaliseHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

// ---------------------------------------------------------------------------
// Parse result types
// ---------------------------------------------------------------------------

export interface ParsedCsvRow {
  /** Original 1-based row number (header = row 1). */
  rowNumber: number;
  fields: Record<KnownHeader, string | undefined>;
}

export interface ParseCsvResult {
  rows: ParsedCsvRow[];
  ignoredColumns: string[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CsvStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvStructureError';
  }
}

export class MissingRequiredHeadersError extends CsvStructureError {
  readonly missingHeaders: string[];
  constructor(missing: string[]) {
    super(`Missing required CSV headers: ${missing.join(', ')}`);
    this.name = 'MissingRequiredHeadersError';
    this.missingHeaders = missing;
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const MAX_ROWS = 500;

/**
 * Parse a CSV buffer into structured rows.
 *
 * - Strips a leading UTF-8 BOM if present.
 * - Normalises header names.
 * - Validates required headers exist.
 * - Collects unknown column names.
 * - Enforces the row limit (excluding the header).
 */
export function parseCsv(buffer: Buffer): ParseCsvResult {
  // Strip UTF-8 BOM (EF BB BF).
  const content =
    buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
      ? buffer.subarray(3)
      : buffer;

  let rawRecords: string[][];
  try {
    rawRecords = parse(content, {
      relax_column_count: true,
      skip_empty_lines: true,
    }) as string[][];
  } catch (err) {
    throw new CsvStructureError(
      `Malformed CSV structure: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (rawRecords.length === 0) {
    throw new CsvStructureError('CSV file is empty');
  }

  // First row is the header.
  const rawHeaders = rawRecords[0] ?? [];
  const normalisedHeaders = rawHeaders.map(normaliseHeader);

  // Validate required headers.
  const missing = REQUIRED_HEADERS.filter((h) => !normalisedHeaders.includes(h));
  if (missing.length > 0) {
    throw new MissingRequiredHeadersError(missing);
  }

  // Identify ignored columns.
  const knownSet = new Set<string>(ALL_KNOWN_HEADERS);
  const ignoredColumns: string[] = [];
  for (const h of normalisedHeaders) {
    if (!knownSet.has(h) && !ignoredColumns.includes(h)) {
      ignoredColumns.push(h);
    }
  }

  // Data rows.
  const dataRows = rawRecords.slice(1);

  if (dataRows.length > MAX_ROWS) {
    throw new CsvStructureError(
      `CSV exceeds the maximum of ${MAX_ROWS} data rows (got ${dataRows.length})`,
    );
  }

  const rows: ParsedCsvRow[] = dataRows.map((cells, idx) => {
    const fields: Partial<Record<KnownHeader, string | undefined>> = {};

    for (let i = 0; i < normalisedHeaders.length; i++) {
      const header = normalisedHeaders[i] as string;
      if (knownSet.has(header)) {
        fields[header as KnownHeader] = cells[i];
      }
    }

    return {
      // Header is row 1; first data row is row 2.
      rowNumber: idx + 2,
      fields: fields as Record<KnownHeader, string | undefined>,
    };
  });

  return { rows, ignoredColumns };
}

