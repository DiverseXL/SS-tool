import { loadEnv } from '../src/config/env.js';
import { closeDatabase, createDatabase } from '../src/db/client.js';
import { seedJudgeDemo } from '../src/public/demo-seed.js';

async function main(): Promise<void> {
  const config = loadEnv();
  const database = createDatabase(config.DATABASE_URL);

  try {
    const result = await seedJudgeDemo(database);
    console.log(
      [
        'Judge demo data is ready.',
        `${result.productCount} products, ${result.evidence.length} accepted evidence records.`,
        `Dataset: ${result.datasetVersion}`,
        ...result.warnings.map((warning) => `Warning: ${warning}`),
      ].join('\n'),
    );
  } finally {
    await closeDatabase(database);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
