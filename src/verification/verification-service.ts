import type { Evidence, EvidenceReview, ReviewStatus } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import type { EvidenceRepository, EvidenceWithSource, ListEvidenceOptions } from '../repositories/evidence-repository.js';
import type { ProductRepository } from '../repositories/product-repository.js';
import type { ProductSourceRepository } from '../repositories/product-source-repository.js';
import type { SourceRepository } from '../repositories/source-repository.js';
import type { ProductAssessmentResult } from './assessment-types.js';
import { detectConflicts } from './conflict-detector.js';
import { assessEvidenceRecord, assessSourceIntegrity } from './evidence-assessment-service.js';

export interface EvidenceDetailResult extends EvidenceWithSource {
  reviews: EvidenceReview[];
}

export interface VerificationService {
  listEvidenceForProduct(options: ListEvidenceOptions): Promise<{
    items: EvidenceWithSource[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  }>;

  getEvidenceDetail(evidenceId: string): Promise<EvidenceDetailResult>;

  assessProductEvidence(productId: string): Promise<ProductAssessmentResult>;

  reviewEvidence(params: {
    evidenceId: string;
    decision: ReviewStatus;
    reviewNote: string;
  }): Promise<{
    evidence: Evidence;
    review: EvidenceReview;
  }>;
}

export interface VerificationServiceDependencies {
  products: ProductRepository;
  evidence: EvidenceRepository;
  sources: SourceRepository;
  productSources: ProductSourceRepository;
}

export function createVerificationService(
  deps: VerificationServiceDependencies,
): VerificationService {
  const { products, evidence, sources, productSources } = deps;

  return {
    async listEvidenceForProduct(options) {
      const product = await products.findById(options.productId);
      if (!product) {
        throw AppError.notFound('PRODUCT_NOT_FOUND', 'Product not found');
      }

      const { items, total } = await evidence.listByProduct(options);
      const totalPages = total === 0 ? 0 : Math.ceil(total / options.pageSize);

      return {
        items,
        pagination: {
          page: options.page,
          pageSize: options.pageSize,
          total,
          totalPages,
        },
      };
    },

    async getEvidenceDetail(evidenceId) {
      const record = await evidence.findDetailById(evidenceId);
      if (!record) {
        throw AppError.notFound('EVIDENCE_NOT_FOUND', 'Evidence record not found');
      }
      const reviews = await evidence.findReviewsForEvidence(evidenceId);
      return {
        ...record,
        reviews,
      };
    },

    async assessProductEvidence(productId) {
      const productDetail = await products.findDetailById(productId);
      if (!productDetail) {
        throw AppError.notFound('PRODUCT_NOT_FOUND', 'Product not found');
      }

      const { manufacturer } = productDetail;
      const allEvidence = await evidence.findAllByProduct(productId);
      const productSourceRows = await productSources.findByProductId(productId);
      const associatedSourceIds = new Set(productSourceRows.map((ps) => ps.sourceId));

      const assessedItems = [];
      const recordsForConflict = [];

      let pendingReview = 0;
      let accepted = 0;
      let rejected = 0;
      let sourceIntegrityFailures = 0;
      let quotationIntegrityFailures = 0;
      let claimIntegrityFailures = 0;

      for (const item of allEvidence) {
        const fullSource = item.evidence.sourceId
          ? await sources.findById(item.evidence.sourceId)
          : null;

        const isAssociated = associatedSourceIds.has(item.evidence.sourceId);

        const assessed = assessEvidenceRecord({
          evidence: item.evidence,
          source: fullSource ?? null,
          manufacturer,
          isAssociatedWithProduct: isAssociated,
        });

        assessedItems.push(assessed);
        recordsForConflict.push({
          evidence: item.evidence,
          source: fullSource ?? null,
        });

        if (item.evidence.reviewStatus === 'pending') pendingReview++;
        else if (item.evidence.reviewStatus === 'accepted') accepted++;
        else if (item.evidence.reviewStatus === 'rejected') rejected++;

        if (!assessed.sourceIntegrity.valid) sourceIntegrityFailures++;
        if (!assessed.quotationIntegrity.valid) quotationIntegrityFailures++;
        if (!assessed.claimIntegrity.valid) claimIntegrityFailures++;
      }

      const { detectedConflicts, claimsRequiringManualReview } = detectConflicts(
        productId,
        recordsForConflict,
      );

      return {
        productId,
        assessmentTimestamp: new Date().toISOString(),
        summary: {
          totalEvidence: allEvidence.length,
          pendingReview,
          accepted,
          rejected,
          sourceIntegrityFailures,
          quotationIntegrityFailures,
          claimIntegrityFailures,
        },
        detectedConflicts,
        claimsRequiringManualReview,
        items: assessedItems,
      };
    },

    async reviewEvidence({ evidenceId, decision, reviewNote }) {
      if (!reviewNote || reviewNote.trim().length === 0) {
        throw new AppError(400, 'VALIDATION_ERROR', 'A meaningful review note is required');
      }

      const evidenceRow = await evidence.findById(evidenceId);
      if (!evidenceRow) {
        throw AppError.notFound('EVIDENCE_NOT_FOUND', 'Evidence record not found');
      }

      if (decision !== 'accepted' && decision !== 'rejected') {
        throw new AppError(
          400,
          'INVALID_DECISION',
          'Review decision must be "accepted" or "rejected"',
        );
      }

      // If accepting evidence, verify that the source passes fundamental integrity checks
      if (decision === 'accepted') {
        const productDetail = await products.findDetailById(evidenceRow.productId);
        if (!productDetail) {
          throw AppError.notFound('PRODUCT_NOT_FOUND', 'Associated product not found');
        }

        const source = await sources.findById(evidenceRow.sourceId);
        const association = await productSources.findAssociation(
          evidenceRow.productId,
          evidenceRow.sourceId,
        );

        const sourceIntegrity = assessSourceIntegrity(
          source ?? null,
          productDetail.manufacturer,
          Boolean(association),
        );

        if (!sourceIntegrity.valid) {
          throw new AppError(
            422,
            'SOURCE_INTEGRITY_FAILED',
            `Cannot accept evidence with invalid source: ${sourceIntegrity.reasons.join('; ')}`,
          );
        }
      }

      const { updatedEvidence, review } = await evidence.updateReviewStatus(
        evidenceId,
        decision,
        evidenceRow.reviewStatus,
        reviewNote.trim(),
      );

      return {
        evidence: updatedEvidence,
        review,
      };
    },
  };
}

