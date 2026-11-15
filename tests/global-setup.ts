import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadEnv } from '../src/config/env.js';
import { closeDatabase, createDatabase } from '../src/db/client.js';

/**
 * Applies pending migrations once before any test worker starts. Without this,
 * Vitest runs integration test files in parallel and two workers can race on
 * the same migration on a fresh database.
 */
export default async function setup(): Promise<void> {
  loadEnv();
  const database = createDatabase(loadEnv().DATABASE_URL);

  try {
    await migrate(database.orm, { migrationsFolder: 'drizzle' });
  } finally {
    await closeDatabase(database);
  }
}
