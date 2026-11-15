import { asc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { manufacturers, type Manufacturer, type NewManufacturer } from '../db/schema.js';
import { translateDatabaseError } from '../lib/errors.js';

export interface ManufacturerRepository {
  create(input: NewManufacturer): Promise<Manufacturer>;
  findById(id: string): Promise<Manufacturer | undefined>;
  findByNormalizedName(normalizedName: string): Promise<Manufacturer | undefined>;
  update(
    id: string,
    data: Partial<Pick<Manufacturer, 'website' | 'countryCode' | 'updatedAt'>>,
  ): Promise<Manufacturer>;
  list(): Promise<Manufacturer[]>;
}

export function createManufacturerRepository(db: Database['orm']): ManufacturerRepository {
  return {
    async create(input) {
      try {
        const [row] = await db.insert(manufacturers).values(input).returning();
        if (!row) throw new Error('insert returned no row');
        return row;
      } catch (error) {
        translateDatabaseError(error, {
          conflictMessage: 'A manufacturer with this name already exists',
        });
      }
    },

    async findById(id) {
      const [row] = await db.select().from(manufacturers).where(eq(manufacturers.id, id)).limit(1);
      return row;
    },

    async findByNormalizedName(normalizedName) {
      const [row] = await db
        .select()
        .from(manufacturers)
        .where(eq(manufacturers.normalizedName, normalizedName))
        .limit(1);
      return row;
    },

    async update(id, data) {
      const [row] = await db
        .update(manufacturers)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(manufacturers.id, id))
        .returning();
      if (!row) throw new Error(`Manufacturer ${id} not found during update`);
      return row;
    },

    async list() {
      return db.select().from(manufacturers).orderBy(asc(manufacturers.name), asc(manufacturers.id));
    },
  };
}
