/**
 * Canonical form used for duplicate detection and unique constraints.
 * Keeps the original spelling for display while comparing case- and
 * whitespace-insensitively.
 */
export function normalizeName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Model identifiers are compared case-insensitively within a manufacturer. */
export function normalizeModelIdentifier(value: string): string {
  return value.normalize('NFKC').trim();
}
