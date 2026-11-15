import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createManufacturerBodySchema } from '../schemas/manufacturer.js';
import type { ManufacturerService } from '../services/manufacturer-service.js';

const manufacturerIdParamsSchema = z.object({
  id: z.uuid('must be a valid UUID'),
});

interface ManufacturerRoutesOptions {
  manufacturerService: ManufacturerService;
}

export const manufacturerRoutes: FastifyPluginAsync<ManufacturerRoutesOptions> = async (
  app,
  options,
) => {
  const { manufacturerService } = options;

  app.post('/api/v1/manufacturers', async (request, reply) => {
    const body = createManufacturerBodySchema.parse(request.body);

    const manufacturer = await manufacturerService.create(body);

    return reply.code(201).send({ data: manufacturer });
  });

  app.get('/api/v1/manufacturers', async () => {
    const manufacturers = await manufacturerService.list();
    return { data: manufacturers };
  });

  app.get('/api/v1/manufacturers/:id', async (request) => {
    const { id } = manufacturerIdParamsSchema.parse(request.params);
    const manufacturer = await manufacturerService.getById(id);
    return { data: manufacturer };
  });
};
