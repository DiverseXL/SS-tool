import type { FastifyPluginAsync } from 'fastify';
import type { ExtractionService } from '../extraction/extraction-service.js';
import type { ResearchService } from '../research/research-service.js';
import { listEvidenceQuerySchema } from '../schemas/evidence.js';
import {
  createProductBodySchema,
  listProductsQuerySchema,
  productIdParamsSchema,
} from '../schemas/product.js';
import type { ProductService } from '../services/product-service.js';
import type { VerificationService } from '../verification/verification-service.js';

interface ProductRoutesOptions {
  productService: ProductService;
  researchService: ResearchService;
  extractionService: ExtractionService;
  verificationService: VerificationService;
}

export const productRoutes: FastifyPluginAsync<ProductRoutesOptions> = async (app, options) => {
  const { productService, researchService, extractionService, verificationService } = options;

  app.post('/api/v1/products', async (request, reply) => {
    const body = createProductBodySchema.parse(request.body);

    const product = await productService.create(body);

    return reply.code(201).send({ data: product });
  });

  app.get('/api/v1/products', async (request) => {
    const query = listProductsQuerySchema.parse(request.query);

    const { items, pagination } = await productService.list(query);

    return { data: items, pagination };
  });

  app.get('/api/v1/products/:id', async (request) => {
    const { id } = productIdParamsSchema.parse(request.params);

    const { product, manufacturer } = await productService.getById(id);

    return { data: { ...product, manufacturer } };
  });

  app.post('/api/v1/products/:id/research', async (request) => {
    const { id } = productIdParamsSchema.parse(request.params);

    const result = await researchService.research(id);

    return { data: result };
  });

  app.post('/api/v1/products/:id/extract-evidence', async (request) => {
    const { id } = productIdParamsSchema.parse(request.params);

    const result = await extractionService.extract(id);

    return { data: result };
  });

  app.get('/api/v1/products/:id/evidence', async (request) => {
    const { id } = productIdParamsSchema.parse(request.params);
    const query = listEvidenceQuerySchema.parse(request.query);

    const { items, pagination } = await verificationService.listEvidenceForProduct({
      productId: id,
      page: query.page,
      pageSize: query.pageSize,
      claimType: query.claimType,
      reviewStatus: query.reviewStatus,
    });

    return {
      data: items.map((item) => ({
        ...item.evidence,
        source: item.source,
      })),
      pagination,
    };
  });

  app.get('/api/v1/products/:id/evidence/assessment', async (request) => {
    const { id } = productIdParamsSchema.parse(request.params);

    const assessment = await verificationService.assessProductEvidence(id);

    return { data: assessment };
  });
};
