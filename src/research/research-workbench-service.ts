import { AppError } from '../lib/errors.js';
import type { ProductRepository } from '../repositories/product-repository.js';
import type {
  ResearchProductRow,
  ResearchSourceRow,
  ResearchWorkbenchRepository,
} from '../repositories/research-workbench-repository.js';
import type { SourceRelationshipType } from '../db/schema.js';

export type ResearchStatus = 'not_researched' | 'candidates_only' | 'sources_fetched';

export interface ResearchProduct {
  id: string;
  name: string;
  manufacturerId: string;
  modelIdentifier: string | null;
  gtin: string | null;
  category: string | null;
  productUrl: string | null;
  createdAt: string;
  updatedAt: string;
  manufacturer: {
    id: string;
    name: string;
    website: string | null;
    countryCode: string | null;
  };
  research: {
    status: ResearchStatus;
    sourceCount: number;
    fetchedSourceCount: number;
    candidateCount: number;
    evidenceCount: number;
    lastActivityAt: string | null;
  };
}

export interface ResearchSource {
  id: string;
  url: string;
  domain: string;
  title: string | null;
  httpStatus: number | null;
  lastFetchedAt: string | null;
  discoveredAt: string;
  relationshipTypes: SourceRelationshipType[];
  isFetched: boolean;
  isExternalCandidate: boolean;
  hasContent: boolean;
}

export interface ResearchProductListResult {
  items: ResearchProduct[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface ResearchWorkbenchService {
  listProducts(options: {
    page: number;
    pageSize: number;
    manufacturerId?: string | undefined;
  }): Promise<ResearchProductListResult>;
  listSources(productId: string): Promise<ResearchSource[]>;
}

const RELATIONSHIP_PRIORITY: Record<SourceRelationshipType, number> = {
  manufacturer_homepage: 0,
  product_page: 1,
  support_page: 2,
  security_advisory: 3,
  policy_page: 4,
  discovered_candidate: 5,
};

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function deriveStatus(fetchedSourceCount: number, sourceCount: number): ResearchStatus {
  if (fetchedSourceCount > 0) return 'sources_fetched';
  if (sourceCount > 0) return 'candidates_only';
  return 'not_researched';
}

function toProduct(row: ResearchProductRow): ResearchProduct {
  const fetchedSourceCount = Number(row.fetchedSourceCount) || 0;
  const sourceCount = Number(row.sourceCount) || 0;

  return {
    id: row.product.id,
    name: row.product.name,
    manufacturerId: row.product.manufacturerId,
    modelIdentifier: row.product.modelIdentifier,
    gtin: row.product.gtin,
    category: row.product.category,
    productUrl: row.product.productUrl,
    createdAt: row.product.createdAt.toISOString(),
    updatedAt: row.product.updatedAt.toISOString(),
    manufacturer: {
      id: row.manufacturer.id,
      name: row.manufacturer.name,
      website: row.manufacturer.website,
      countryCode: row.manufacturer.countryCode,
    },
    research: {
      status: deriveStatus(fetchedSourceCount, sourceCount),
      sourceCount,
      fetchedSourceCount,
      candidateCount: Number(row.candidateCount) || 0,
      evidenceCount: Number(row.evidenceCount) || 0,
      lastActivityAt: toIso(row.lastActivityAt),
    },
  };
}

function groupSourceRows(rows: ResearchSourceRow[]): ResearchSource[] {
  const grouped = new Map<string, ResearchSource>();

  for (const row of rows) {
    const existing = grouped.get(row.sourceId);
    if (existing) {
      if (!existing.relationshipTypes.includes(row.relationshipType)) {
        existing.relationshipTypes.push(row.relationshipType);
      }
      if (row.fetchedAt) {
        const current = existing.lastFetchedAt ? new Date(existing.lastFetchedAt) : null;
        if (!current || row.fetchedAt > current) {
          existing.lastFetchedAt = row.fetchedAt.toISOString();
        }
      }
      existing.httpStatus = row.httpStatus;
      existing.hasContent = existing.hasContent || row.hasContent;
      continue;
    }

    grouped.set(row.sourceId, {
      id: row.sourceId,
      url: row.url,
      domain: row.domain,
      title: row.title,
      httpStatus: row.httpStatus,
      lastFetchedAt: row.fetchedAt?.toISOString() ?? null,
      discoveredAt: row.discoveredAt.toISOString(),
      relationshipTypes: [row.relationshipType],
      isFetched:
        row.httpStatus !== null &&
        row.httpStatus >= 200 &&
        row.httpStatus <= 299 &&
        row.fetchedAt !== null,
      isExternalCandidate: false,
      hasContent: row.hasContent,
    });
  }

  return [...grouped.values()]
    .map((source) => {
      source.relationshipTypes.sort(
        (left, right) => RELATIONSHIP_PRIORITY[left] - RELATIONSHIP_PRIORITY[right],
      );
      source.isFetched =
        source.httpStatus !== null &&
        source.httpStatus >= 200 &&
        source.httpStatus <= 299 &&
        source.lastFetchedAt !== null;
      source.isExternalCandidate =
        source.relationshipTypes.every((role) => role === 'discovered_candidate') &&
        !source.isFetched;
      return source;
    })
    .sort((left, right) => {
      if (left.isFetched !== right.isFetched) return left.isFetched ? -1 : 1;
      const leftTime = left.lastFetchedAt ?? left.discoveredAt;
      const rightTime = right.lastFetchedAt ?? right.discoveredAt;
      return rightTime.localeCompare(leftTime);
    });
}

export function createResearchWorkbenchService(deps: {
  products: ProductRepository;
  repository: ResearchWorkbenchRepository;
}): ResearchWorkbenchService {
  const { products, repository } = deps;

  return {
    async listProducts(options) {
      const { items, total } = await repository.listProducts(options);

      return {
        items: items.map(toProduct),
        pagination: {
          page: options.page,
          pageSize: options.pageSize,
          total,
          totalPages: total === 0 ? 0 : Math.ceil(total / options.pageSize),
        },
      };
    },

    async listSources(productId) {
      const product = await products.findById(productId);
      if (!product) {
        throw AppError.notFound('PRODUCT_NOT_FOUND', 'Product not found');
      }

      return groupSourceRows(await repository.findSourceRowsForProduct(productId));
    },
  };
}
