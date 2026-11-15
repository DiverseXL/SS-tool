import { count, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  evidence,
  manufacturers,
  productSources,
  products,
  sources,
  type Manufacturer,
  type Product,
  type SourceRelationshipType,
} from '../db/schema.js';

export interface ResearchProductRow {
  product: Product;
  manufacturer: Manufacturer;
  sourceCount: number;
  fetchedSourceCount: number;
  candidateCount: number;
  evidenceCount: number;
  lastActivityAt: Date | null;
}

export interface ResearchSourceRow {
  sourceId: string;
  url: string;
  domain: string;
  title: string | null;
  httpStatus: number | null;
  fetchedAt: Date | null;
  relationshipType: SourceRelationshipType;
  discoveredAt: Date;
  hasContent: boolean;
}

export interface ResearchProductListOptions {
  page: number;
  pageSize: number;
  manufacturerId?: string | undefined;
}

export interface ResearchWorkbenchRepository {
  listProducts(
    options: ResearchProductListOptions,
  ): Promise<{ items: ResearchProductRow[]; total: number }>;
  findSourceRowsForProduct(productId: string): Promise<ResearchSourceRow[]>;
}

export function createResearchWorkbenchRepository(
  db: Database['orm'],
): ResearchWorkbenchRepository {
  return {
    async listProducts({ page, pageSize, manufacturerId }) {
      const where = manufacturerId ? eq(products.manufacturerId, manufacturerId) : undefined;

      const items = await db
        .select({
          product: products,
          manufacturer: manufacturers,
          // Counts use distinct so joining both sources and evidence does not
          // multiply the totals.
          sourceCount: sql<number>`count(distinct ${productSources.sourceId})::int`,
          fetchedSourceCount: sql<number>`count(distinct case
            when ${productSources.relationshipType} <> 'discovered_candidate'
              and ${sources.httpStatus} between 200 and 299
            then ${productSources.sourceId}
          end)::int`,
          candidateCount: sql<number>`count(distinct case
            when ${productSources.relationshipType} = 'discovered_candidate'
            then ${productSources.sourceId}
          end)::int`,
          evidenceCount: sql<number>`count(distinct ${evidence.id})::int`,
          lastActivityAt: sql<Date | null>`max(coalesce(${sources.fetchedAt}, ${productSources.discoveredAt}))`,
        })
        .from(products)
        .innerJoin(manufacturers, eq(products.manufacturerId, manufacturers.id))
        .leftJoin(productSources, eq(products.id, productSources.productId))
        .leftJoin(sources, eq(productSources.sourceId, sources.id))
        .leftJoin(evidence, eq(products.id, evidence.productId))
        .where(where)
        .groupBy(products.id, manufacturers.id)
        .orderBy(desc(products.createdAt), desc(products.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const [totalRow] = await db.select({ value: count() }).from(products).where(where);

      return {
        items,
        total: Number(totalRow?.value ?? 0),
      };
    },

    async findSourceRowsForProduct(productId) {
      const hasContent = sql<boolean>`(${sources.contentText} is not null and btrim(${sources.contentText}) <> '')`;

      return db
        .select({
          sourceId: sources.id,
          url: sources.url,
          domain: sources.domain,
          title: sources.title,
          httpStatus: sources.httpStatus,
          fetchedAt: sources.fetchedAt,
          relationshipType: productSources.relationshipType,
          discoveredAt: productSources.discoveredAt,
          hasContent,
        })
        .from(productSources)
        .innerJoin(sources, eq(productSources.sourceId, sources.id))
        .where(eq(productSources.productId, productId))
        .orderBy(
          sql`${sources.fetchedAt} desc nulls last`,
          desc(productSources.discoveredAt),
          sources.url,
        );
    },
  };
}
