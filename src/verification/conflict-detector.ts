import type { ClaimType, Evidence } from '../db/schema.js';
import { parseDateText, type ParsedDate } from '../extraction/date-normalizer.js';
import type { ConflictGroup, ConflictingEvidenceItem, ManualReviewClaimItem } from './assessment-types.js';

export interface EvidenceRecordForConflict {
  evidence: Evidence;
  source: { url: string } | null;
}

interface DateSpan {
  earliest: string; // YYYY-MM-DD
  latest: string; // YYYY-MM-DD
}

function toSpan(parsed: ParsedDate): DateSpan | null {
  if (parsed.precision === 'day' && parsed.normalizedDate) {
    return { earliest: parsed.normalizedDate, latest: parsed.normalizedDate };
  }

  if (parsed.precision === 'month') {
    // key is "month:YYYY-MM"
    const match = /^month:(\d{4})-(\d{2})$/.exec(parsed.key);
    if (!match || !match[1] || !match[2]) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const earliest = `${year}-${String(month).padStart(2, '0')}-01`;
    // Last day of month: day 0 of month + 1
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const latest = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return { earliest, latest };
  }

  if (parsed.precision === 'year') {
    // key is "year:YYYY"
    const match = /^year:(\d{4})$/.exec(parsed.key);
    if (!match || !match[1]) return null;
    const year = Number(match[1]);
    return { earliest: `${year}-01-01`, latest: `${year}-12-31` };
  }

  return null;
}

export function detectConflicts(
  productId: string,
  records: EvidenceRecordForConflict[],
): {
  detectedConflicts: ConflictGroup[];
  claimsRequiringManualReview: ManualReviewClaimItem[];
} {
  const detectedConflicts: ConflictGroup[] = [];
  const claimsRequiringManualReview: ManualReviewClaimItem[] = [];

  // Exclude explicitly rejected evidence from active conflict calculations
  const activeRecords = records.filter((r) => r.evidence.reviewStatus !== 'rejected');

  const supportedDateClaims: ClaimType[] = ['support_start', 'support_end'];

  for (const claimType of supportedDateClaims) {
    const claims = activeRecords.filter((r) => r.evidence.claimType === claimType);
    if (claims.length < 2) continue;

    // Parse dates for all claims in this type
    const parsedClaims: Array<{
      record: EvidenceRecordForConflict;
      parsed: ParsedDate | null;
      span: DateSpan | null;
    }> = [];

    for (const claim of claims) {
      if (!claim.evidence.dateText) {
        claimsRequiringManualReview.push({
          evidenceId: claim.evidence.id,
          claimType,
          reason: `Evidence has no dateText for date-based claim type "${claimType}"`,
        });
        continue;
      }

      const parsed = parseDateText(claim.evidence.dateText);
      if (!parsed) {
        claimsRequiringManualReview.push({
          evidenceId: claim.evidence.id,
          claimType,
          reason: `Date text "${claim.evidence.dateText}" cannot be parsed into a calendar date or standard month/year precision`,
        });
        continue;
      }

      parsedClaims.push({
        record: claim,
        parsed,
        span: toSpan(parsed),
      });
    }

    // Compare each pair of parsed claims
    const conflictingPairs: Array<{
      itemA: (typeof parsedClaims)[number];
      itemB: (typeof parsedClaims)[number];
      explanation: string;
    }> = [];

    for (let i = 0; i < parsedClaims.length; i++) {
      for (let j = i + 1; j < parsedClaims.length; j++) {
        const a = parsedClaims[i]!;
        const b = parsedClaims[j]!;

        // Exact match on parsed key (e.g. both day:2030-12-31 or both month:2030-12 or both year:2030)
        // -> Duplicate corroboration! Not a conflict.
        if (a.parsed && b.parsed && a.parsed.key === b.parsed.key) {
          continue;
        }

        // Check if precisions are the same
        if (a.parsed?.precision === b.parsed?.precision) {
          // Same precision, different key -> direct conflict!
          const explanation = `Contradictory ${claimType} commitments: "${a.record.evidence.dateText}" vs "${b.record.evidence.dateText}"`;
          conflictingPairs.push({ itemA: a, itemB: b, explanation });
          continue;
        }

        // Precisions are different (e.g., month vs year, or day vs month)
        // Check spans
        if (a.span && b.span) {
          // If spans are disjoint (e.g. Month Dec 2030 vs Year 2032): definitely contradictory
          const isDisjoint = a.span.latest < b.span.earliest || b.span.latest < a.span.earliest;
          if (isDisjoint) {
            const explanation = `Contradictory ${claimType} commitments across different precisions: "${a.record.evidence.dateText}" vs "${b.record.evidence.dateText}"`;
            conflictingPairs.push({ itemA: a, itemB: b, explanation });
          } else {
            // Spans overlap (e.g. "December 2030" and "2030").
            // One is more specific than the other. Per requirements:
            // "Where two claims cannot safely be compared, classify them as requiring manual review."
            // Rather than inventing a conflict or an equivalence, flag for manual review.
            claimsRequiringManualReview.push({
              evidenceId: a.record.evidence.id,
              claimType,
              reason: `Different date precision with overlapping span compared to evidence ${b.record.evidence.id} ("${a.record.evidence.dateText}" [${a.parsed?.precision}] vs "${b.record.evidence.dateText}" [${b.parsed?.precision}]) requires manual review`,
            });
            claimsRequiringManualReview.push({
              evidenceId: b.record.evidence.id,
              claimType,
              reason: `Different date precision with overlapping span compared to evidence ${a.record.evidence.id} ("${b.record.evidence.dateText}" [${b.parsed?.precision}] vs "${a.record.evidence.dateText}" [${a.parsed?.precision}]) requires manual review`,
            });
          }
        } else {
          claimsRequiringManualReview.push({
            evidenceId: a.record.evidence.id,
            claimType,
            reason: `Claims cannot safely be compared due to uncalculated date spans`,
          });
          claimsRequiringManualReview.push({
            evidenceId: b.record.evidence.id,
            claimType,
            reason: `Claims cannot safely be compared due to uncalculated date spans`,
          });
        }
      }
    }

    if (conflictingPairs.length > 0) {
      // Group conflicting claims for this claimType
      const evidenceMap = new Map<string, ConflictingEvidenceItem>();
      const explanations: string[] = [];

      for (const pair of conflictingPairs) {
        for (const item of [pair.itemA, pair.itemB]) {
          if (!evidenceMap.has(item.record.evidence.id)) {
            evidenceMap.set(item.record.evidence.id, {
              evidenceId: item.record.evidence.id,
              rawText: item.record.evidence.rawText,
              dateText: item.record.evidence.dateText,
              datePrecision: item.record.evidence.datePrecision,
              normalizedDate: item.record.evidence.normalizedDate,
              reviewStatus: item.record.evidence.reviewStatus,
              sourceUrl: item.record.source?.url ?? null,
              quotedExcerpt: item.record.evidence.quotedExcerpt,
            });
          }
        }
        if (!explanations.includes(pair.explanation)) {
          explanations.push(pair.explanation);
        }
      }

      detectedConflicts.push({
        productId,
        claimType,
        conflictingEvidenceIds: Array.from(evidenceMap.keys()),
        evidence: Array.from(evidenceMap.values()),
        conflictExplanation: explanations.join('; '),
      });
    }
  }

  // Deduplicate manual review claims by evidenceId + reason
  const uniqueManual = new Map<string, ManualReviewClaimItem>();
  for (const item of claimsRequiringManualReview) {
    const key = `${item.evidenceId}:${item.reason}`;
    if (!uniqueManual.has(key)) {
      uniqueManual.set(key, item);
    }
  }

  return {
    detectedConflicts,
    claimsRequiringManualReview: Array.from(uniqueManual.values()),
  };
}

