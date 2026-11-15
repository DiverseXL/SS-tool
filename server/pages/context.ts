import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Database } from '../../src/db/client.js';
import { createExtractionService } from '../../src/extraction/extraction-service.js';
import { createAiProviderFromEnv } from '../../src/extraction/openai-compatible-provider.js';
import { createPublicService } from '../../src/public/public-service.js';
import { createJudgeDemoService } from '../../src/public/judge-demo.js';
import { createDashboardRepository } from '../../src/repositories/dashboard-repository.js';
import { createEvidenceRepository } from '../../src/repositories/evidence-repository.js';
import { createManufacturerRepository } from '../../src/repositories/manufacturer-repository.js';
import { createProductRepository } from '../../src/repositories/product-repository.js';
import { createProductSourceRepository } from '../../src/repositories/product-source-repository.js';
import { createResearchWorkbenchRepository } from '../../src/repositories/research-workbench-repository.js';
import { createReviewQueueRepository } from '../../src/repositories/review-queue-repository.js';
import { createSourceRepository } from '../../src/repositories/source-repository.js';
import { createResearchService } from '../../src/research/research-service.js';
import { createEdgeFetcher, edgeValidateUrl } from './edge-fetcher.js';
import { createResearchWorkbenchService } from '../../src/research/research-workbench-service.js';
import { createManufacturerService } from '../../src/services/manufacturer-service.js';
import { createProductService } from '../../src/services/product-service.js';
import { createReviewQueueService } from '../../src/verification/review-queue-service.js';
import { createVerificationService } from '../../src/verification/verification-service.js';
import { createPagesAuthService, type PagesAuthService } from './auth.js';
import type { PagesEnv } from './env.js';

export interface PagesAppContext {
  database: Database;
  auth: PagesAuthService;
  dashboardRepository: ReturnType<typeof createDashboardRepository>;
  manufacturerRepository: ReturnType<typeof createManufacturerRepository>;
  productRepository: ReturnType<typeof createProductRepository>;
  manufacturerService: ReturnType<typeof createManufacturerService>;
  productService: ReturnType<typeof createProductService>;
  researchService: ReturnType<typeof createResearchService>;
  extractionService: ReturnType<typeof createExtractionService>;
  verificationService: ReturnType<typeof createVerificationService>;
  publicService: ReturnType<typeof createPublicService>;
  judgeDemoService: ReturnType<typeof createJudgeDemoService>;
  researchWorkbenchService: ReturnType<typeof createResearchWorkbenchService>;
  reviewQueueService: ReturnType<typeof createReviewQueueService>;
}

function connectionString(env: PagesEnv): string {
  const value = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!value) {
    throw new Error(
      'Database is not configured. Bind HYPERDRIVE in Cloudflare or set DATABASE_URL for local Pages development.',
    );
  }
  return value;
}

export function getDatabase(env: PagesEnv): Database {
  // Cloudflare forbids reusing I/O objects (sockets) across requests, so each
  // Pages request gets its own short-lived pool. Hyperdrive does the real
  // connection pooling in front of PostgreSQL.
  const client = postgres(connectionString(env), {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => {},
  });
  const database: Database = {
    orm: drizzle(client),
    client,
    async ping() {
      await client`select 1`;
    },
  };
  return database;
}

export async function closeDatabase(database: Database): Promise<void> {
  await database.client.end({ timeout: 5 });
}

const logger = {
  info(fields: object, message?: string) {
    console.log(message ?? 'info', fields);
  },
  warn(fields: object, message?: string) {
    console.warn(message ?? 'warn', fields);
  },
  error(fields: object, message?: string) {
    console.error(message ?? 'error', fields);
  },
};

export function createPagesContext(env: PagesEnv): PagesAppContext {
  const database = getDatabase(env);

  const manufacturerRepository = createManufacturerRepository(database.orm);
  const productRepository = createProductRepository(database.orm);
  const sourceRepository = createSourceRepository(database.orm);
  const productSourceRepository = createProductSourceRepository(database.orm);
  const evidenceRepository = createEvidenceRepository(database.orm);
  const dashboardRepository = createDashboardRepository(database.orm);
  const researchWorkbenchRepository = createResearchWorkbenchRepository(database.orm);
  const reviewQueueRepository = createReviewQueueRepository(database.orm);

  const manufacturerService = createManufacturerService(manufacturerRepository);
  const productService = createProductService(productRepository, manufacturerRepository);

  const researchService = createResearchService({
    products: productRepository,
    sources: sourceRepository,
    productSources: productSourceRepository,
    fetcher: createEdgeFetcher(),
    validateUrl: edgeValidateUrl,
  });

  const ai = createAiProviderFromEnv(env as NodeJS.ProcessEnv);
  const extractionService = createExtractionService({
    products: productRepository,
    evidence: evidenceRepository,
    provider: ai.provider,
    ...(ai.reason ? { configurationError: ai.reason } : {}),
    ...(ai.config?.maxInputTokens !== undefined
      ? { maxInputTokens: ai.config.maxInputTokens }
      : {}),
    ...(ai.config?.maxOutputTokens !== undefined
      ? { maxOutputTokens: ai.config.maxOutputTokens }
      : {}),
    logger,
  });

  const verificationService = createVerificationService({
    products: productRepository,
    evidence: evidenceRepository,
    sources: sourceRepository,
    productSources: productSourceRepository,
  });

  const publicService = createPublicService({
    products: productRepository,
    evidence: evidenceRepository,
    sources: sourceRepository,
  });

  const researchWorkbenchService = createResearchWorkbenchService({
    products: productRepository,
    repository: researchWorkbenchRepository,
  });

  const reviewQueueService = createReviewQueueService({
    repository: reviewQueueRepository,
  });

  return {
    database,
    auth: createPagesAuthService(database, env),
    dashboardRepository,
    manufacturerRepository,
    productRepository,
    manufacturerService,
    productService,
    researchService,
    extractionService,
    verificationService,
    publicService,
    judgeDemoService: createJudgeDemoService(publicService),
    researchWorkbenchService,
    reviewQueueService,
  };
}
