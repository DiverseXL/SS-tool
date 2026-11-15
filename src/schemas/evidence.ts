import { z } from 'zod';

export const listEvidenceQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  claimType: z.enum(['support_start', 'support_end', 'os_version', 'policy'] as const).optional(),
  reviewStatus: z.enum(['pending', 'accepted', 'rejected'] as const).optional(),
});

export const evidenceIdParamsSchema = z.object({
  id: z.uuid('must be a valid UUID'),
});

export const reviewEvidenceBodySchema = z
  .object({
    decision: z
      .enum(['accepted', 'rejected'] as const)
      .refine((v) => v === 'accepted' || v === 'rejected', {
        message: 'Decision must be either "accepted" or "rejected"',
      }),
    reviewNote: z.string().trim().min(3, 'Review note must be at least 3 characters long'),
  })
  .strict();

export type ListEvidenceQuery = z.infer<typeof listEvidenceQuerySchema>;
export type ReviewEvidenceBody = z.infer<typeof reviewEvidenceBodySchema>;

