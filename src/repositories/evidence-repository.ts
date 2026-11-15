import { and, count, desc, eq, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  evidence,
  evidenceReviews,
  productSources,
  sources,
  type ClaimType,
  type Evidence,
  type EvidenceReview,
  type ReviewStatus,
  type SourceRelationshipType,
} from '../db/schema.js';

export interface ProductSourceForExtraction {
  sourceId: string;
  url: string;
  domain: string;
  title: string | null;
  contentText: string | null;
  httpStatus: number | null;
  fetchedAt: Date | null;
  relationshipType: SourceRelationshipType;
}

export interface ExistingEvidenceForDedup {
  id: string;
  claimType: ClaimType;
  quotedExcerpt: string;
  reviewStatus: Evidence['reviewStatus'];
  extractionMethod: Evidence['extractionMethod'];
  claimFingerprint: string | null;
}

export interface NewAiEvidence {
  productId: string;
  sourceId: string;
  claimType: ClaimType;
  rawText: string;
  dateText: string | null;
  datePrecision: Evidence['datePrecision'];
  normalizedDate: string | null;
  quotedExcerpt: string;
  confidence: number;
  explanation: string;
  claimFingerprint: string;
}

export interface SafeSourceInfo {
  id: string;
  url: string;
  domain: string;
  title: string | null;
  description: string | null;
  contentType: string | null;
  httpStatus: number | null;
  fetchedAt: Date | null;
}

export interface EvidenceWithSource {
  evidence: Evidence;
  source: SafeSourceInfo | null;
}

export interface ListEvidenceOptions {
  productId: string;
  page: number;
  pageSize: number;
  claimType?: ClaimType | undefined;
  reviewStatus?: ReviewStatus | undefined;
}

export interface EvidenceRepository {
  /** Every source association for a product, including duplicate roles. */
  findSourcesForProduct(productId: string): Promise<ProductSourceForExtraction[]>;
  /** Loads existing claims for deduplication; never updates them. */
  findClaimsForSource(
    productId: string,
    sourceId: string,
    claimType: ClaimType,
  ): Promise<ExistingEvidenceForDedup[]>;
  /**
   * Inserts a pending AI evidence row. Returns null when a claim with the same
   * fingerprint already exists. Existing rows are never updated, so reviewed
   * evidence cannot be overwritten by a repeated extraction.
   */
  insertAiEvidence(input: NewAiEvidence): Promise<Evidence | null>;

  /** Finds a single evidence record by id. */
  findById(id: string): Promise<Evidence | undefined>;

  /** Finds an evidence record by id along with its source information. */
  findDetailById(id: string): Promise<EvidenceWithSource | undefined>;

  /** Lists evidence records for a product with pagination and optional filters. */
  listByProduct(options: ListEvidenceOptions): Promise<{ items: EvidenceWithSource[]; total: number }>;

  /** Lists all evidence records for a product (used for full assessment/conflict detection). */
  findAllByProduct(productId: string): Promise<EvidenceWithSource[]>;

  /** Updates review status of an evidence row and records a review history record. */
  updateReviewStatus(
    evidenceId: string,
    decision: ReviewStatus,
    previousStatus: ReviewStatus,
    reviewNote: string,
  ): Promise<{ updatedEvidence: Evidence; review: EvidenceReview }>;

  /** Lists review history for an evidence record. */
  findReviewsForEvidence(evidenceId: string): Promise<EvidenceReview[]>;
}

export function createEvidenceRepository(db: Database['orm']): EvidenceRepository {
  return {
    async findSourcesForProduct(productId) {
      return db
        .select({
          sourceId: sources.id,
          url: sources.url,
          domain: sources.domain,
          title: sources.title,
          contentText: sources.contentText,
          httpStatus: sources.httpStatus,
          fetchedAt: sources.fetchedAt,
          relationshipType: productSources.relationshipType,
        })
        .from(productSources)
        .innerJoin(sources, eq(productSources.sourceId, sources.id))
        .where(eq(productSources.productId, productId));
    },

    async findClaimsForSource(productId, sourceId, claimType) {
      return db
        .select({
          id: evidence.id,
          claimType: evidence.claimType,
          quotedExcerpt: evidence.quotedExcerpt,
          reviewStatus: evidence.reviewStatus,
          extractionMethod: evidence.extractionMethod,
          claimFingerprint: evidence.claimFingerprint,
        })
        .from(evidence)
        .where(
          and(
            eq(evidence.productId, productId),
            eq(evidence.sourceId, sourceId),
            eq(evidence.claimType, claimType),
          ),
        );
    },

    async insertAiEvidence(input) {
      const [row] = await db
        .insert(evidence)
        .values({
          productId: input.productId,
          sourceId: input.sourceId,
          claimType: input.claimType,
          rawText: input.rawText,
          dateText: input.dateText,
          datePrecision: input.datePrecision,
          normalizedDate: input.normalizedDate,
          quotedExcerpt: input.quotedExcerpt,
          confidence: input.confidence,
          explanation: input.explanation,
          claimFingerprint: input.claimFingerprint,
          extractionMethod: 'ai',
          // Extraction never approves evidence. Humans review it later.
          reviewStatus: 'pending',
        })
        .onConflictDoNothing()
        .returning();

      return row ?? null;
    },

    async findById(id) {
      const [row] = await db.select().from(evidence).where(eq(evidence.id, id)).limit(1);
      return row;
    },

    async findDetailById(id) {
      const [row] = await db
        .select({
          evidence,
          source: {
            id: sources.id,
            url: sources.url,
            domain: sources.domain,
            title: sources.title,
            description: sources.description,
            contentType: sources.contentType,
            httpStatus: sources.httpStatus,
            fetchedAt: sources.fetchedAt,
          },
        })
        .from(evidence)
        .leftJoin(sources, eq(evidence.sourceId, sources.id))
        .where(eq(evidence.id, id))
        .limit(1);

      return row;
    },

    async listByProduct({ productId, page, pageSize, claimType, reviewStatus }) {
      const conditions: SQL[] = [eq(evidence.productId, productId)];

      if (claimType) {
        conditions.push(eq(evidence.claimType, claimType));
      }
      if (reviewStatus) {
        conditions.push(eq(evidence.reviewStatus, reviewStatus));
      }

      const where = and(...conditions);

      const items = await db
        .select({
          evidence,
          source: {
            id: sources.id,
            url: sources.url,
            domain: sources.domain,
            title: sources.title,
            description: sources.description,
            contentType: sources.contentType,
            httpStatus: sources.httpStatus,
            fetchedAt: sources.fetchedAt,
          },
        })
        .from(evidence)
        .leftJoin(sources, eq(evidence.sourceId, sources.id))
        .where(where)
        .orderBy(desc(evidence.createdAt), desc(evidence.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const [totalRow] = await db.select({ value: count() }).from(evidence).where(where);

      return {
        items,
        total: Number(totalRow?.value ?? 0),
      };
    },

    async findAllByProduct(productId) {
      return db
        .select({
          evidence,
          source: {
            id: sources.id,
            url: sources.url,
            domain: sources.domain,
            title: sources.title,
            description: sources.description,
            contentType: sources.contentType,
            httpStatus: sources.httpStatus,
            fetchedAt: sources.fetchedAt,
          },
        })
        .from(evidence)
        .leftJoin(sources, eq(evidence.sourceId, sources.id))
        .where(eq(evidence.productId, productId))
        .orderBy(desc(evidence.createdAt), desc(evidence.id));
    },

    async updateReviewStatus(evidenceId, decision, previousStatus, reviewNote) {
      // Execute in a transaction so evidence status update and history insertion stay atomic
      return db.transaction(async (tx) => {
        const [updatedEvidence] = await tx
          .update(evidence)
          .set({
            reviewStatus: decision,
            updatedAt: new Date(),
          })
          .where(eq(evidence.id, evidenceId))
          .returning();

        if (!updatedEvidence) {
          throw new Error('Evidence update returned no row');
        }

        const [review] = await tx
          .insert(evidenceReviews)
          .values({
            evidenceId,
            decision,
            previousStatus,
            reviewNote,
          })
          .returning();

        if (!review) {
          throw new Error('Evidence review insert returned no row');
        }

        return { updatedEvidence, review };
      });
    },

    async findReviewsForEvidence(evidenceId) {
      return db
        .select()
        .from(evidenceReviews)
        .where(eq(evidenceReviews.evidenceId, evidenceId))
        .orderBy(desc(evidenceReviews.createdAt));
    },
  };
}
