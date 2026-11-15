import type { Evidence, Manufacturer, Source } from '../db/schema.js';
import { isManufacturerDomain, validateClaimSemantics } from '../extraction/claim-guards.js';
import { parseDateText } from '../extraction/date-normalizer.js';
import { normalizeQuotationText, validateQuotation } from '../extraction/quotation-validator.js';
import type { EvidenceAssessmentItem, IntegrityCheckResult } from './assessment-types.js';

export interface AssessSingleEvidenceInput {
  evidence: Evidence;
  source: Source | null;
  manufacturer: Manufacturer;
  isAssociatedWithProduct: boolean;
}

export function assessSourceIntegrity(
  source: Source | null,
  manufacturer: Manufacturer,
  isAssociatedWithProduct: boolean,
): IntegrityCheckResult {
  const reasons: string[] = [];

  if (!source) {
    return {
      valid: false,
      reasons: ['Source record does not exist'],
    };
  }

  if (source.httpStatus === null || source.httpStatus < 200 || source.httpStatus >= 300) {
    reasons.push(
      `Source was not successfully fetched (HTTP status: ${source.httpStatus ?? 'none'})`,
    );
  }

  if (!isAssociatedWithProduct) {
    reasons.push('Source is not associated with this product');
  }

  if (!isManufacturerDomain(source.domain, manufacturer.website)) {
    reasons.push(
      `Source domain (${source.domain}) does not match manufacturer website (${manufacturer.website ?? 'unregistered'})`,
    );
  }

  if (!source.contentText || source.contentText.trim().length === 0) {
    reasons.push('Source contains no stored textual content');
  }

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

export function assessQuotationIntegrity(
  evidence: Evidence,
  source: Source | null,
): IntegrityCheckResult {
  const reasons: string[] = [];

  if (!evidence.quotedExcerpt || evidence.quotedExcerpt.trim().length === 0) {
    return {
      valid: false,
      reasons: ['Quotation excerpt is empty'],
    };
  }

  if (!source?.contentText) {
    return {
      valid: false,
      reasons: ['No source content available to verify quotation'],
    };
  }

  const quoteValidation = validateQuotation(evidence.quotedExcerpt, source.contentText);
  if (!quoteValidation.matched) {
    reasons.push(
      `Quotation does not appear in stored source text (${quoteValidation.reason ?? 'mismatch'})`,
    );
  }

  // Does the date text appear in the supporting quotation?
  if (evidence.dateText) {
    const normalizedQuote = normalizeQuotationText(evidence.quotedExcerpt);
    const normalizedDate = normalizeQuotationText(evidence.dateText);
    if (!normalizedQuote.includes(normalizedDate)) {
      reasons.push(
        `Date text "${evidence.dateText}" does not appear in the supporting quotation`,
      );
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

export function assessClaimIntegrity(evidence: Evidence): IntegrityCheckResult {
  const reasons: string[] = [];

  const semanticsResult = validateClaimSemantics(
    evidence.claimType,
    evidence.quotedExcerpt,
    evidence.dateText,
  );

  if (semanticsResult) {
    reasons.push(`Claim integrity failure [${semanticsResult.code}]: ${semanticsResult.message}`);
  }

  // If a date was provided, verify it parses consistently
  if (evidence.dateText) {
    const parsed = parseDateText(evidence.dateText);
    if (evidence.normalizedDate && parsed?.normalizedDate && evidence.normalizedDate !== parsed.normalizedDate) {
      reasons.push(
        `Normalized date mismatch: stored ${evidence.normalizedDate} vs parsed ${parsed.normalizedDate}`,
      );
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

export function assessEvidenceRecord(input: AssessSingleEvidenceInput): EvidenceAssessmentItem {
  const { evidence, source, manufacturer, isAssociatedWithProduct } = input;

  const sourceIntegrity = assessSourceIntegrity(source, manufacturer, isAssociatedWithProduct);
  const quotationIntegrity = assessQuotationIntegrity(evidence, source);
  const claimIntegrity = assessClaimIntegrity(evidence);

  const overallIntegrity =
    sourceIntegrity.valid && quotationIntegrity.valid && claimIntegrity.valid;

  return {
    evidenceId: evidence.id,
    claimType: evidence.claimType,
    rawText: evidence.rawText,
    quotedExcerpt: evidence.quotedExcerpt,
    dateText: evidence.dateText,
    datePrecision: evidence.datePrecision,
    normalizedDate: evidence.normalizedDate,
    confidence: evidence.confidence,
    extractionMethod: evidence.extractionMethod,
    reviewStatus: evidence.reviewStatus,
    source: source
      ? {
          id: source.id,
          url: source.url,
          domain: source.domain,
          title: source.title,
          description: source.description,
          contentType: source.contentType,
          httpStatus: source.httpStatus,
          fetchedAt: source.fetchedAt,
        }
      : null,
    sourceIntegrity,
    quotationIntegrity,
    claimIntegrity,
    overallIntegrity,
  };
}

