import { and, count, desc, eq, ilike, inArray, ne, or, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  evidence,
  manufacturers,
  products,
  sources,
  type ClaimType,
  type DatePrecision,
  type Evidence,
  type ExtractionMethod,
  type ReviewStatus,
} from '../db/schema.js';

export interface ReviewQueueEvidence {
  id: string;
  productId: string;
  sourceId: string;
  claimType: ClaimType;
  rawText: string;
  dateText: string | null;
  datePrecision: DatePrecision | null;
  normalizedDate: string | null;
  extractionMethod: ExtractionMethod;
  reviewStatus: ReviewStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReviewQueueItemRow {
  evidence: ReviewQueueEvidence;
  product: {
    id: string;
    name: string;
    modelIdentifier: string | null;
    category: string | null;
  };
  manufacturer: {
    id: string;
    name: string;
  };
  source: {
    id: string;
    url: string;
    domain: string;
    title: string | null;
    httpStatus: number | null;
    fetchedAt: Date | null;
  } | null;
}

export interface ActiveDateClaimRow {
  evidence: Evidence;
  sourceUrl: string | null;
}

export interface ReviewQueueListOptions {
  page: number;
  pageSize: number;
  reviewStatus?: ReviewStatus | undefined;
  search?: string | undefined;
  evidenceIds?: string[] | undefined;
}

export interface ReviewQueueRepository {
  list(options: ReviewQueueListOptions): Promise<{ items: ReviewQueueItemRow[]; total: number }>;
  countByStatus(): Promise<Record<ReviewStatus, number>>;
  findActiveDateClaims(): Promise<ActiveDateClaimRow[]>;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function createReviewQueueRepository(db: Database['orm']): ReviewQueueRepository {
  return {
    async list({ page, pageSize, reviewStatus, search, evidenceIds }) {
      if (evidenceIds && evidenceIds.length === 0) {
        return { items: [], total: 0 };
      }

      const conditions: SQL[] = [];
      if (reviewStatus) conditions.push(eq(evidence.reviewStatus, reviewStatus));
      if (evidenceIds) conditions.push(inArray(evidence.id, evidenceIds));

      if (search) {
        const pattern = `%${escapeLike(search)}%`;
        const searchCondition = or(
          ilike(products.name, pattern),
          ilike(products.modelIdentifier, pattern),
          ilike(products.gtin, pattern),
          ilike(manufacturers.name, pattern),
        );
        if (searchCondition) conditions.push(searchCondition);
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const items = await db
        .select({
          evidence: {
            id: evidence.id,
            productId: evidence.productId,
            sourceId: evidence.sourceId,
            claimType: evidence.claimType,
            rawText: evidence.rawText,
            dateText: evidence.dateText,
            datePrecision: evidence.datePrecision,
            normalizedDate: evidence.normalizedDate,
            extractionMethod: evidence.extractionMethod,
            reviewStatus: evidence.reviewStatus,
            createdAt: evidence.createdAt,
            updatedAt: evidence.updatedAt,
          },
          product: {
            id: products.id,
            name: products.name,
            modelIdentifier: products.modelIdentifier,
            category: products.category,
          },
          manufacturer: {
            id: manufacturers.id,
            name: manufacturers.name,
          },
          source: {
            id: sources.id,
            url: sources.url,
            domain: sources.domain,
            title: sources.title,
            httpStatus: sources.httpStatus,
            fetchedAt: sources.fetchedAt,
          },
        })
        .from(evidence)
        .innerJoin(products, eq(evidence.productId, products.id))
        .innerJoin(manufacturers, eq(products.manufacturerId, manufacturers.id))
        .leftJoin(sources, eq(evidence.sourceId, sources.id))
        .where(where)
        .orderBy(desc(evidence.createdAt), desc(evidence.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const [totalRow] = await db
        .select({ value: count() })
        .from(evidence)
        .innerJoin(products, eq(evidence.productId, products.id))
        .innerJoin(manufacturers, eq(products.manufacturerId, manufacturers.id))
        .where(where);

      return {
        items,
        total: Number(totalRow?.value ?? 0),
      };
    },

    async countByStatus() {
      const rows = await db
        .select({ status: evidence.reviewStatus, value: count() })
        .from(evidence)
        .groupBy(evidence.reviewStatus);

      const counts: Record<ReviewStatus, number> = {
        pending: 0,
        accepted: 0,
        rejected: 0,
      };

      for (const row of rows) {
        counts[row.status] = Number(row.value) || 0;
      }

      return counts;
    },

    async findActiveDateClaims() {
      return db
        .select({
          evidence,
          sourceUrl: sources.url,
        })
        .from(evidence)
        .leftJoin(sources, eq(evidence.sourceId, sources.id))
        .where(
          and(
            ne(evidence.reviewStatus, 'rejected'),
            inArray(evidence.claimType, ['support_start', 'support_end']),
          ),
        );
    },
  };
}
