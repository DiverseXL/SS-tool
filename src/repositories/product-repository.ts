import { and, count, desc, eq, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { manufacturers, products, type Manufacturer, type NewProduct, type Product } from '../db/schema.js';
import { translateDatabaseError } from '../lib/errors.js';

export interface ProductListOptions {
  page: number;
  pageSize: number;
  manufacturerId?: string | undefined;
}

export interface ProductWithManufacturer {
  product: Product;
  manufacturer: Manufacturer;
}

export interface ProductRepository {
  create(input: NewProduct): Promise<Product>;
  findById(id: string): Promise<Product | undefined>;
  findDetailById(id: string): Promise<ProductWithManufacturer | undefined>;
  findByManufacturerAndModel(
    manufacturerId: string,
    modelIdentifier: string,
  ): Promise<Product | undefined>;
  findByManufacturerAndGtin(
    manufacturerId: string,
    gtin: string,
  ): Promise<Product | undefined>;
  findByGtin(gtin: string): Promise<ProductWithManufacturer[]>;
  findByManufacturerNameAndModel(
    manufacturerName: string,
    modelIdentifier: string,
  ): Promise<ProductWithManufacturer[]>;
  list(options: ProductListOptions): Promise<{ items: Product[]; total: number }>;
}

export function createProductRepository(db: Database['orm']): ProductRepository {
  return {
    async create(input) {
      try {
        const [row] = await db.insert(products).values(input).returning();
        if (!row) throw new Error('insert returned no row');
        return row;
      } catch (error) {
        translateDatabaseError(error, {
          conflictMessage: 'A product with this model identifier already exists for this manufacturer',
          foreignKeyMessage: 'Manufacturer not found',
        });
      }
    },

    async findById(id) {
      const [row] = await db.select().from(products).where(eq(products.id, id)).limit(1);
      return row;
    },

    async findDetailById(id) {
      const [row] = await db
        .select({ product: products, manufacturer: manufacturers })
        .from(products)
        .innerJoin(manufacturers, eq(products.manufacturerId, manufacturers.id))
        .where(eq(products.id, id))
        .limit(1);
      return row;
    },

    async findByManufacturerAndModel(manufacturerId, modelIdentifier) {
      const [row] = await db
        .select()
        .from(products)
        .where(
          and(
            eq(products.manufacturerId, manufacturerId),
            sql`lower(${products.modelIdentifier}) = ${modelIdentifier.toLowerCase()}`,
          ),
        )
        .limit(1);
      return row;
    },

    async findByManufacturerAndGtin(manufacturerId, gtin) {
      const [row] = await db
        .select()
        .from(products)
        .where(and(eq(products.manufacturerId, manufacturerId), eq(products.gtin, gtin)))
        .limit(1);
      return row;
    },

    async findByGtin(gtin) {
      return db
        .select({ product: products, manufacturer: manufacturers })
        .from(products)
        .innerJoin(manufacturers, eq(products.manufacturerId, manufacturers.id))
        .where(eq(products.gtin, gtin));
    },

    async findByManufacturerNameAndModel(manufacturerName, modelIdentifier) {
      const normalized = manufacturerName.toLowerCase().trim();
      return db
        .select({ product: products, manufacturer: manufacturers })
        .from(products)
        .innerJoin(manufacturers, eq(products.manufacturerId, manufacturers.id))
        .where(
          and(
            or(
              eq(manufacturers.normalizedName, normalized),
              sql`lower(${manufacturers.name}) = ${normalized}`,
            ),
            sql`lower(${products.modelIdentifier}) = ${modelIdentifier.toLowerCase().trim()}`,
          ),
        );
    },

    async list({ page, pageSize, manufacturerId }) {
      const where = manufacturerId ? eq(products.manufacturerId, manufacturerId) : undefined;

      const items = await db
        .select()
        .from(products)
        .where(where)
        .orderBy(desc(products.createdAt), desc(products.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const [totalRow] = await db.select({ value: count() }).from(products).where(where);

      return { items, total: Number(totalRow?.value ?? 0) };
    },
  };
}
