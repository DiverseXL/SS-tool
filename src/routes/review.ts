import type { FastifyPluginAsync } from 'fastify';
import { evidenceQueueQuerySchema } from '../schemas/review.js';
import type { ReviewQueueService } from '../verification/review-queue-service.js';

interface ReviewRoutesOptions {
  reviewQueueService: ReviewQueueService;
}

export const reviewRoutes: FastifyPluginAsync<ReviewRoutesOptions> = async (app, options) => {
  const { reviewQueueService } = options;

  app.get('/api/v1/dashboard/evidence-queue', async (request) => {
    const query = evidenceQueueQuerySchema.parse(request.query);
    const result = await reviewQueueService.list({
      page: query.page,
      pageSize: query.pageSize,
      status: query.reviewStatus,
      ...(query.search ? { search: query.search } : {}),
    });

    return {
      data: result.items,
      pagination: result.pagination,
      counts: result.counts,
    };
  });
};
