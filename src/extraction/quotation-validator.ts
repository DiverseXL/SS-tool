/**
 * Quotation verification.
 *
 * Every extracted claim must quote the fetched manufacturer page. The model's
 * quotation is compared against the stored source text after Unicode and
 * whitespace normalisation. Ellipses are allowed so a model can quote two
 * separate passages, but every fragment must still occur in order.
 */

const MIN_QUOTE_CHARS = 8;

export function normalizeQuotationText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export type QuotationMatchMethod = 'exact' | 'ellipsis';

export interface QuotationValidation {
  matched: boolean;
  method?: QuotationMatchMethod;
  reason?: string;
}

/**
 * Validates that a quotation genuinely appears in the source text.
 * Ellipsis-separated fragments are matched in order so reordered snippets are
 * rejected.
 */
export function validateQuotation(
  quotation: string,
  sourceText: string,
): QuotationValidation {
  const normalizedQuote = normalizeQuotationText(quotation);
  const normalizedSource = normalizeQuotationText(sourceText);

  if (normalizedQuote.length < MIN_QUOTE_CHARS) {
    return { matched: false, reason: 'quotation_too_short' };
  }

  if (normalizedSource.includes(normalizedQuote)) {
    return { matched: true, method: 'exact' };
  }

  const fragments = quotation
    .split(/\.{3,}|\u2026/)
    .map((fragment) => normalizeQuotationText(fragment))
    .filter((fragment) => fragment.length > 0);

  if (fragments.length < 2) {
    return { matched: false, reason: 'quotation_not_found_in_source' };
  }

  let cursor = 0;
  for (const fragment of fragments) {
    if (fragment.length < MIN_QUOTE_CHARS) {
      return { matched: false, reason: 'quotation_fragment_too_short' };
    }

    const index = normalizedSource.indexOf(fragment, cursor);
    if (index === -1) {
      return { matched: false, reason: 'quotation_not_found_in_source' };
    }
    cursor = index + fragment.length;
  }

  return { matched: true, method: 'ellipsis' };
}
