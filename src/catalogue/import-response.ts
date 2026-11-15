// ---------------------------------------------------------------------------
// Import response types — the JSON contract for POST /api/v1/catalogue/imports
// ---------------------------------------------------------------------------

export type RowStatus = 'created' | 'duplicate' | 'rejected';

export interface CreatedRowResult {
  row: number;
  status: 'created';
  productId: string;
}

export interface DuplicateRowResult {
  row: number;
  status: 'duplicate';
  reason: string;
}

export interface RejectedRowResult {
  row: number;
  status: 'rejected';
  errors: Array<{ field: string; message: string }>;
}

export type RowResult = CreatedRowResult | DuplicateRowResult | RejectedRowResult;

export interface ImportSummary {
  totalRows: number;
  created: number;
  duplicates: number;
  failed: number;
}

export interface ImportResponse {
  summary: ImportSummary;
  results: RowResult[];
  ignoredColumns: string[];
  warnings: string[];
}

