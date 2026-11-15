import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

// Keep this file self-contained: Drizzle Kit does not run the validated runtime
// env loader, and resolving a .js import to a .ts source file is fragile here.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env before running Drizzle Kit.');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
