import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { productSources, type NewProductSource, type ProductSource } from '../db/schema.js';

export interface ProductSourceRepository {
  /** Idempotent: repeating a research run must not duplicate associations. */
  associate(input: NewProductSource): Promise<{ inserted: boolean }>;
  /** Checks if a specific product and source are associated. */
  findAssociation(productId: string, sourceId: string): Promise<ProductSource | undefined>;
  /** Finds all source associations for a product. */
  findByProductId(productId: string): Promise<ProductSource[]>;
}

export function createProductSourceRepository(db: Database['orm']): ProductSourceRepository {
  return {
    async associate(input) {
      const rows = await db
        .insert(productSources)
        .values(input)
        .onConflictDoNothing({
          target: [
            productSources.productId,
            productSources.sourceId,
            productSources.relationshipType,
          ],
        })
        .returning({ id: productSources.id });

      return { inserted: rows.length > 0 };
    },

    async findAssociation(productId, sourceId) {
      const [row] = await db
        .select()
        .from(productSources)
        .where(
          and(
            eq(productSources.productId, productId),
            eq(productSources.sourceId, sourceId),
          ),
        )
        .limit(1);
      return row;
    },

    async findByProductId(productId) {
      return db
        .select()
        .from(productSources)
        .where(eq(productSources.productId, productId));
    },
  };
}
