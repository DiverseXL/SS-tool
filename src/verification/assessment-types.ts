import type { ClaimType, DatePrecision, Evidence, ReviewStatus } from '../db/schema.js';
import type { SafeSourceInfo } from '../repositories/evidence-repository.js';

export interface IntegrityCheckResult {
  valid: boolean;
  reasons: string[];
}

export interface EvidenceAssessmentItem {
  evidenceId: string;
  claimType: ClaimType;
  rawText: string;
  quotedExcerpt: string;
  dateText: string | null;
  datePrecision: DatePrecision | null;
  normalizedDate: string | null;
  confidence: number | null;
  extractionMethod: Evidence['extractionMethod'];
  reviewStatus: ReviewStatus;
  source: SafeSourceInfo | null;
  sourceIntegrity: IntegrityCheckResult;
  quotationIntegrity: IntegrityCheckResult;
  claimIntegrity: IntegrityCheckResult;
  overallIntegrity: boolean;
}

export interface ConflictingEvidenceItem {
  evidenceId: string;
  rawText: string;
  dateText: string | null;
  datePrecision: DatePrecision | null;
  normalizedDate: string | null;
  reviewStatus: ReviewStatus;
  sourceUrl: string | null;
  quotedExcerpt: string;
}

export interface ConflictGroup {
  productId: string;
  claimType: ClaimType;
  conflictingEvidenceIds: string[];
  evidence: ConflictingEvidenceItem[];
  conflictExplanation: string;
}

export interface ManualReviewClaimItem {
  evidenceId: string;
  claimType: ClaimType;
  reason: string;
}

export interface AssessmentCounts {
  totalEvidence: number;
  pendingReview: number;
  accepted: number;
  rejected: number;
  sourceIntegrityFailures: number;
  quotationIntegrityFailures: number;
  claimIntegrityFailures: number;
}

export interface ProductAssessmentResult {
  productId: string;
  assessmentTimestamp: string;
  summary: AssessmentCounts;
  detectedConflicts: ConflictGroup[];
  claimsRequiringManualReview: ManualReviewClaimItem[];
  items: EvidenceAssessmentItem[];
}

