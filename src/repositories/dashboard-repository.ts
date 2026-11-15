import { count, countDistinct, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  evidence,
  manufacturers,
  productSources,
  products,
} from '../db/schema.js';

export interface DashboardRecentProduct {
  id: string;
  name: string;
  modelIdentifier: string | null;
  gtin: string | null;
  category: string | null;
  createdAt: Date;
  manufacturer: { id: string; name: string };
}

export interface DashboardSummary {
  products: {
    total: number;
    withSources: number;
    withoutSources: number;
    withAcceptedEvidence: number;
  };
  manufacturers: { total: number };
  evidence: { pendingReview: number };
  recentProducts: DashboardRecentProduct[];
}

export interface DashboardRepository {
  getSummary(): Promise<DashboardSummary>;
}

function numericCount(value: unknown): number {
  return Number(value ?? 0);
}

export function createDashboardRepository(db: Database['orm']): DashboardRepository {
  return {
    async getSummary() {
      // Aggregates run in PostgreSQL. No catalogue rows are loaded just to
      // calculate dashboard numbers.
      const [productTotals, manufacturerTotals, sourceCoverage, pendingReview, acceptedCoverage, recent] =
        await Promise.all([
          db.select({ total: count() }).from(products),
          db.select({ total: count() }).from(manufacturers),
          db
            .select({ sourcedProducts: countDistinct(productSources.productId) })
            .from(productSources),
          db
            .select({ pending: count() })
            .from(evidence)
            .where(eq(evidence.reviewStatus, 'pending')),
          db
            .select({ reviewedProducts: countDistinct(evidence.productId) })
            .from(evidence)
            .where(eq(evidence.reviewStatus, 'accepted')),
          db
            .select({
              id: products.id,
              name: products.name,
              modelIdentifier: products.modelIdentifier,
              gtin: products.gtin,
              category: products.category,
              createdAt: products.createdAt,
              manufacturerId: manufacturers.id,
              manufacturerName: manufacturers.name,
            })
            .from(products)
            .innerJoin(manufacturers, eq(products.manufacturerId, manufacturers.id))
            .orderBy(desc(products.createdAt), desc(products.id))
            .limit(5),
        ]);

      const totalProducts = numericCount(productTotals[0]?.total);
      const withSources = numericCount(sourceCoverage[0]?.sourcedProducts);

      return {
        products: {
          total: totalProducts,
          withSources,
          withoutSources: Math.max(0, totalProducts - withSources),
          withAcceptedEvidence: numericCount(acceptedCoverage[0]?.reviewedProducts),
        },
        manufacturers: { total: numericCount(manufacturerTotals[0]?.total) },
        evidence: { pendingReview: numericCount(pendingReview[0]?.pending) },
        recentProducts: recent.map((row) => ({
          id: row.id,
          name: row.name,
          modelIdentifier: row.modelIdentifier,
          gtin: row.gtin,
          category: row.category,
          createdAt: row.createdAt,
          manufacturer: { id: row.manufacturerId, name: row.manufacturerName },
        })),
      };
    },
  };
}
