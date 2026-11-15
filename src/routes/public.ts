import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import type { JudgeDemoService } from '../public/judge-demo.js';
import type { PublicService } from '../public/public-service.js';
import { productIdParamsSchema } from '../schemas/product.js';
import { publicProductLookupQuerySchema } from '../schemas/public.js';

const demoExtractBodySchema = z.object({
  demoProductId: z.string().trim().min(1, 'demoProductId is required'),
});

interface PublicRoutesOptions {
  publicService: PublicService;
  judgeDemoService?: JudgeDemoService;
}

export const publicRoutes: FastifyPluginAsync<PublicRoutesOptions> = async (app, options) => {
  const { publicService, judgeDemoService } = options;

  app.get('/demo', async (_request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    return reply.sendFile('demo.html', { cacheControl: false });
  });

  app.get('/demo/', async (_request, reply) => reply.redirect('/demo'));
  app.get('/demo.html', async (_request, reply) => reply.redirect('/demo'));

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

  app.get('/api/v1/public/demo/products', async (_request, reply) => {
    const products = judgeDemoService ? await judgeDemoService.listDemoProducts() : [];

    void reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=30');
    return { data: products };
  });

  // Live SERV preview for the landing-page judge panel. Restricted to fixed
  // server-side demo products, rate limited, and never persisted.
  app.post('/api/v1/public/demo/extract', async (request, reply) => {
    if (!judgeDemoService) {
      throw new AppError(503, 'AI_NOT_CONFIGURED', 'Judge demonstration service is not configured.');
    }

    const body = demoExtractBodySchema.parse(request.body);
    const clientIp = request.ip || '127.0.0.1';

    const result = await judgeDemoService.runDemoExtraction({
      demoProductId: body.demoProductId,
      clientIp,
    });

    void reply.header('Cache-Control', 'no-store');
    return { data: result };
  });
};
