import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sources, type NewSource, type Source } from '../db/schema.js';

export interface SourceRepository {
  findById(id: string): Promise<Source | undefined>;
  findByUrl(url: string): Promise<Source | undefined>;
  upsert(input: NewSource): Promise<Source>;
}

export function createSourceRepository(db: Database['orm']): SourceRepository {
  return {
    async findById(id) {
      const [row] = await db.select().from(sources).where(eq(sources.id, id)).limit(1);
      return row;
    },

    async findByUrl(url) {
      const [row] = await db.select().from(sources).where(eq(sources.url, url)).limit(1);
      return row;
    },

    async upsert(input) {
      const [row] = await db
        .insert(sources)
        .values(input)
        .onConflictDoUpdate({
          target: sources.url,
          set: {
            domain: input.domain,
            title: input.title ?? null,
            description: input.description ?? null,
            contentType: input.contentType ?? null,
            contentText: input.contentText ?? null,
            httpStatus: input.httpStatus ?? null,
            contentHash: input.contentHash ?? null,
            fetchedAt: input.fetchedAt ?? null,
            updatedAt: new Date(),
          },
        })
        .returning();

      if (!row) throw new Error('source upsert returned no row');
      return row;
    },
  };
}
