import type { FastifyPluginAsync } from 'fastify';
import { evidenceIdParamsSchema, reviewEvidenceBodySchema } from '../schemas/evidence.js';
import type { VerificationService } from '../verification/verification-service.js';

interface EvidenceRoutesOptions {
  verificationService: VerificationService;
}

export const evidenceRoutes: FastifyPluginAsync<EvidenceRoutesOptions> = async (app, options) => {
  const { verificationService } = options;

  app.get('/api/v1/evidence/:id', async (request) => {
    const { id } = evidenceIdParamsSchema.parse(request.params);

    const record = await verificationService.getEvidenceDetail(id);

    return {
      data: {
        ...record.evidence,
        source: record.source,
        reviews: record.reviews,
      },
    };
  });

  app.post('/api/v1/evidence/:id/review', async (request, reply) => {
    const { id } = evidenceIdParamsSchema.parse(request.params);
    const body = reviewEvidenceBodySchema.parse(request.body);

    const result = await verificationService.reviewEvidence({
      evidenceId: id,
      decision: body.decision,
      reviewNote: body.reviewNote,
    });

    return reply.code(200).send({
      data: {
        evidence: result.evidence,
        review: result.review,
      },
    });
  });
};

