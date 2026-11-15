import { z } from 'zod';
import { isValidGtin } from '../lib/gtin.js';
import { httpUrlSchema, optionalText } from './manufacturer.js';

const gtinSchema = z
  .string()
  .trim()
  .refine(
    (value) => value === '' || isValidGtin(value),
    'must be a valid GTIN-8/12/13/14 with a correct check digit',
  )
  .optional()
  .transform((value) => (value ? value : undefined));

export const createProductBodySchema = z
  .object({
    manufacturerId: z.uuid('must be a valid UUID'),
    name: z.string().trim().min(1, 'is required').max(300),
    modelIdentifier: optionalText(120),
    gtin: gtinSchema,
    sku: optionalText(100),
    category: optionalText(120),
    productUrl: httpUrlSchema.optional(),
    marketRegion: optionalText(60),
  })
  .strict();

export const productIdParamsSchema = z.object({
  id: z.uuid('must be a valid UUID'),
});

export const listProductsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  manufacturerId: z.uuid('must be a valid UUID').optional(),
});

export type CreateProductBody = z.infer<typeof createProductBodySchema>;
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;
