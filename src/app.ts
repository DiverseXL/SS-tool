import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { createAuthService, type AuthConfig } from './auth/auth-service.js';
import { registerAuthGuard } from './auth/guard.js';
import type { Database } from './db/client.js';
import { createExtractionService } from './extraction/extraction-service.js';
import { createAiProviderFromEnv } from './extraction/openai-compatible-provider.js';
import type { AiProvider } from './extraction/provider.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { createDashboardRepository } from './repositories/dashboard-repository.js';
import { createEvidenceRepository } from './repositories/evidence-repository.js';
import { createManufacturerRepository } from './repositories/manufacturer-repository.js';
import { createProductRepository } from './repositories/product-repository.js';
import { createProductSourceRepository } from './repositories/product-source-repository.js';
import { createResearchWorkbenchRepository } from './repositories/research-workbench-repository.js';
import { createReviewQueueRepository } from './repositories/review-queue-repository.js';
import { createSourceRepository } from './repositories/source-repository.js';
import { createSafeFetcher, type Fetcher } from './research/fetcher.js';
import { createResearchService, type UrlValidator } from './research/research-service.js';
import { createResearchWorkbenchService } from './research/research-workbench-service.js';
import { authRoutes } from './routes/auth.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { healthRoutes } from './routes/health.js';
import { manufacturerRoutes } from './routes/manufacturers.js';
import { productRoutes } from './routes/products.js';
import { catalogueRoutes } from './routes/catalogue.js';
import { evidenceRoutes } from './routes/evidence.js';
import { publicRoutes } from './routes/public.js';
import { researchRoutes } from './routes/research.js';
import { reviewRoutes } from './routes/review.js';
import { createPublicService } from './public/public-service.js';
import { createJudgeDemoService } from './public/judge-demo.js';
import { createManufacturerService } from './services/manufacturer-service.js';
import { createProductService } from './services/product-service.js';
import { createReviewQueueService } from './verification/review-queue-service.js';
import { createVerificationService } from './verification/verification-service.js';

export interface BuildAppOptions {
  database: Database;
  logger?: FastifyServerOptions['logger'];
  /** Injected in tests so research never touches the network. */
  research?: {
    fetcher?: Fetcher;
    validateUrl?: UrlValidator;
  };
  /**
   * AI extraction overrides. Tests inject a deterministic provider (or null to
   * exercise the unconfigured path). When omitted, the provider is built from
   * the AI_* environment variables.
   */
  extraction?: {
    provider?: AiProvider | null;
    maxInputTokens?: number;
    maxOutputTokens?: number;
  };
  /** Single-admin dashboard credentials. Omit to leave login unconfigured. */
  auth?: AuthConfig;
}

/**
 * Builds the Fastify application without starting a listener, so tests can
 * exercise it through `app.inject()` and the server entrypoint owns process
 * lifecycle concerns.
 */
export function buildApp({
  database,
  logger = { level: 'info' },
  research,
  extraction,
  auth,
}: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger });
  const authService = createAuthService(auth);

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
    fetcher: research?.fetcher ?? createSafeFetcher(),
    ...(research?.validateUrl ? { validateUrl: research.validateUrl } : {}),
  });

  const environmentProvider =
    extraction?.provider === undefined ? createAiProviderFromEnv() : undefined;
  const provider =
    extraction?.provider !== undefined
      ? extraction.provider
      : (environmentProvider?.provider ?? null);
  const configurationError =
    extraction?.provider === undefined ? environmentProvider?.reason : undefined;

  const maxInputTokens =
    extraction?.maxInputTokens ?? environmentProvider?.config?.maxInputTokens;
  const maxOutputTokens =
    extraction?.maxOutputTokens ?? environmentProvider?.config?.maxOutputTokens;

  const extractionService = createExtractionService({
    products: productRepository,
    evidence: evidenceRepository,
    provider,
    ...(configurationError ? { configurationError } : {}),
    ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    logger: app.log,
  });

  const researchWorkbenchService = createResearchWorkbenchService({
    products: productRepository,
    repository: researchWorkbenchRepository,
  });

  const reviewQueueService = createReviewQueueService({ repository: reviewQueueRepository });

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

  const judgeDemoService = createJudgeDemoService(publicService, provider);

  registerErrorHandler(app);
  void app.register(fastifyCookie, { secret: authService.cookieSecret });
  registerAuthGuard(app, authService);
  // Marketing page and its assets. Exact API routes are registered below and
  // take precedence over this plugin's wildcard route.
  void app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public', import.meta.url)),
    prefix: '/',
    index: ['index.html'],
    cacheControl: true,
    maxAge: '1h',
    list: false,
  });
  void app.register(healthRoutes, { database });
  void app.register(authRoutes, { authService });
  void app.register(dashboardRoutes, { authService, dashboardRepository });
  void app.register(researchRoutes, { researchWorkbenchService });
  void app.register(reviewRoutes, { reviewQueueService });
  void app.register(manufacturerRoutes, { manufacturerService });
  void app.register(productRoutes, {
    productService,
    researchService,
    extractionService,
    verificationService,
  });
  void app.register(catalogueRoutes, { manufacturerRepository, productRepository });
  void app.register(evidenceRoutes, { verificationService });
  void app.register(publicRoutes, { publicService, judgeDemoService });

  return app;
}
