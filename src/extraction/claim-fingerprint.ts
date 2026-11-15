import { createHash } from 'node:crypto';
import { parseDateText } from './date-normalizer.js';
import { normalizeQuotationText } from './quotation-validator.js';

/**
 * Stable identity for an extracted claim.
 *
 * The fingerprint intentionally excludes the model's wording of `statement`,
 * explanation and confidence: the same source quotation and date must resolve
 * to the same claim even if the model describes it slightly differently on a
 * later run. Source ID is included so the same claim on two different
 * manufacturer pages remains two corroborating pieces of evidence.
 */
export function createClaimFingerprint(input: {
  productId: string;
  sourceId: string;
  claimType: string;
  quotation: string;
  dateText: string | null;
}): string {
  const dateKey = input.dateText
    ? (parseDateText(input.dateText)?.key ?? `text:${normalizeQuotationText(input.dateText)}`)
    : 'none';

  const material = [
    'v1',
    input.productId,
    input.sourceId,
    input.claimType,
    normalizeQuotationText(input.quotation),
    dateKey,
  ].join('\u0000');

  return createHash('sha256').update(material, 'utf8').digest('hex');
}
