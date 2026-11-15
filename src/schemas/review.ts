import { z } from 'zod';

export const evidenceQueueQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  reviewStatus: z
    .enum(['pending', 'accepted', 'rejected', 'conflicting', 'all'] as const)
    .default('pending'),
  search: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((value) => (value ? value : undefined)),
});

export type EvidenceQueueQuery = z.infer<typeof evidenceQueueQuerySchema>;
