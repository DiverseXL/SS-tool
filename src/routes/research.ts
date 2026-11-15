import type { FastifyPluginAsync } from 'fastify';
import { productIdParamsSchema, listProductsQuerySchema } from '../schemas/product.js';
import type { ResearchWorkbenchService } from '../research/research-workbench-service.js';

interface ResearchRoutesOptions {
  researchWorkbenchService: ResearchWorkbenchService;
}

export const researchRoutes: FastifyPluginAsync<ResearchRoutesOptions> = async (app, options) => {
  const { researchWorkbenchService } = options;

  app.get('/api/v1/dashboard/research/products', async (request) => {
    const query = listProductsQuerySchema.parse(request.query);

    const result = await researchWorkbenchService.listProducts({
      page: query.page,
      pageSize: query.pageSize,
      manufacturerId: query.manufacturerId,
    });

    return { data: result.items, pagination: result.pagination };
  });

  app.get('/api/v1/products/:id/sources', async (request) => {
    const { id } = productIdParamsSchema.parse(request.params);
    const sources = await researchWorkbenchService.listSources(id);
    return { data: sources };
  });
};
