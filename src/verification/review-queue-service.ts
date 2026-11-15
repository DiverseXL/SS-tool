import type { ClaimType, DatePrecision, ReviewStatus } from '../db/schema.js';
import type {
  ActiveDateClaimRow,
  ReviewQueueItemRow,
  ReviewQueueRepository,
} from '../repositories/review-queue-repository.js';
import { detectConflicts } from './conflict-detector.js';

export type ReviewQueueStatusFilter = ReviewStatus | 'conflicting' | 'all';

export interface ReviewQueueItem {
  id: string;
  productId: string;
  sourceId: string;
  claimType: ClaimType;
  statement: string;
  dateText: string | null;
  datePrecision: DatePrecision | null;
  normalizedDate: string | null;
  extractionMethod: string;
  extractionTimestamp: string;
  status: ReviewStatus;
  conflicting: boolean;
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
    lastFetchedAt: string | null;
  } | null;
}

export interface ReviewQueueCounts {
  all: number;
  pending: number;
  accepted: number;
  rejected: number;
  conflicting: number;
}

export interface ReviewQueue {
  items: ReviewQueueItem[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  counts: ReviewQueueCounts;
}

export interface ReviewQueueService {
  list(options: {
    page: number;
    pageSize: number;
    status: ReviewQueueStatusFilter;
    search?: string | undefined;
  }): Promise<ReviewQueue>;
}

function conflictEvidenceIds(rows: ActiveDateClaimRow[]): Set<string> {
  const byProduct = new Map<string, ActiveDateClaimRow[]>();

  for (const row of rows) {
    const group = byProduct.get(row.evidence.productId);
    if (group) group.push(row);
    else byProduct.set(row.evidence.productId, [row]);
  }

  const ids = new Set<string>();
  for (const [productId, records] of byProduct) {
    const { detectedConflicts } = detectConflicts(
      productId,
      records.map((row) => ({
        evidence: row.evidence,
        source: row.sourceUrl ? { url: row.sourceUrl } : null,
      })),
    );

    for (const conflict of detectedConflicts) {
      for (const id of conflict.conflictingEvidenceIds) ids.add(id);
    }
  }

  return ids;
}

function toItem(row: ReviewQueueItemRow, conflicting: boolean): ReviewQueueItem {
  return {
    id: row.evidence.id,
    productId: row.evidence.productId,
    sourceId: row.evidence.sourceId,
    claimType: row.evidence.claimType,
    statement: row.evidence.rawText,
    dateText: row.evidence.dateText,
    datePrecision: row.evidence.datePrecision,
    normalizedDate: row.evidence.normalizedDate,
    extractionMethod: row.evidence.extractionMethod,
    extractionTimestamp: row.evidence.createdAt.toISOString(),
    status: row.evidence.reviewStatus,
    conflicting,
    product: row.product,
    manufacturer: row.manufacturer,
    source: row.source
      ? {
          id: row.source.id,
          url: row.source.url,
          domain: row.source.domain,
          title: row.source.title,
          httpStatus: row.source.httpStatus,
          lastFetchedAt: row.source.fetchedAt?.toISOString() ?? null,
        }
      : null,
  };
}

export function createReviewQueueService(deps: {
  repository: ReviewQueueRepository;
}): ReviewQueueService {
  const { repository } = deps;

  return {
    async list(options) {
      const [statusCounts, activeDateClaims] = await Promise.all([
        repository.countByStatus(),
        repository.findActiveDateClaims(),
      ]);
      const conflictingIds = conflictEvidenceIds(activeDateClaims);
      const counts: ReviewQueueCounts = {
        all: statusCounts.pending + statusCounts.accepted + statusCounts.rejected,
        pending: statusCounts.pending,
        accepted: statusCounts.accepted,
        rejected: statusCounts.rejected,
        conflicting: conflictingIds.size,
      };

      const conflictFilter = options.status === 'conflicting';
      const statusFilter =
        options.status === 'all' || options.status === 'conflicting'
          ? undefined
          : options.status;

      const { items, total } = await repository.list({
        page: options.page,
        pageSize: options.pageSize,
        reviewStatus: statusFilter,
        search: options.search,
        ...(conflictFilter ? { evidenceIds: [...conflictingIds] } : {}),
      });

      return {
        items: items.map((item) => toItem(item, conflictingIds.has(item.evidence.id))),
        pagination: {
          page: options.page,
          pageSize: options.pageSize,
          total,
          totalPages: total === 0 ? 0 : Math.ceil(total / options.pageSize),
        },
        counts,
      };
    },
  };
}
