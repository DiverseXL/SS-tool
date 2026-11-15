import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

export interface Database {
  /** Drizzle query builder for type-safe access. */
  orm: PostgresJsDatabase;
  /** Underlying postgres.js client, used for raw queries and shutdown. */
  client: Sql;
  /** Lightweight connectivity probe used by the readiness endpoint. */
  ping(): Promise<void>;
}

export interface CreateDatabaseOptions {
  maxConnections?: number;
}

export function createDatabase(connectionString: string, options: CreateDatabaseOptions = {}): Database {
  const client = postgres(connectionString, {
    max: options.maxConnections ?? 10,
    idle_timeout: 20,
    connect_timeout: 5,
    // Keep server notices out of the structured logs; errors are logged explicitly.
    onnotice: () => {},
  });

  const orm = drizzle(client);

  return {
    orm,
    client,
    async ping() {
      await client`select 1`;
    },
  };
}

export async function closeDatabase(database: Database): Promise<void> {
  await database.client.end({ timeout: 5 });
}
