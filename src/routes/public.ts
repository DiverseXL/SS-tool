import type { FastifyPluginAsync } from 'fastify';
import type { PublicService } from '../public/public-service.js';
import { productIdParamsSchema } from '../schemas/product.js';
import { publicProductLookupQuerySchema } from '../schemas/public.js';

interface PublicRoutesOptions {
  publicService: PublicService;
}

export const publicRoutes: FastifyPluginAsync<PublicRoutesOptions> = async (app, options) => {
  const { publicService } = options;

  app.get('/api/v1/public/products/lookup', async (request, reply) => {
    const query = publicProductLookupQuerySchema.parse(request.query);

    const result = await publicService.lookupProduct(query);

    void reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=30');
    return { data: result };
  });

  app.get('/api/v1/public/products/:id/support-card', async (request, reply) => {
    const { id } = productIdParamsSchema.parse(request.params);

    const supportCard = await publicService.getSupportCard(id);

    void reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=30');
    return { data: supportCard };
  });
};

