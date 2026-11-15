import { z } from 'zod';
import { isValidGtin } from '../lib/gtin.js';

export const publicProductLookupQuerySchema = z.object({
  gtin: z
    .string()
    .trim()
    .refine((v) => v === '' || isValidGtin(v), 'must be a valid GTIN-8/12/13/14 with a correct check digit')
    .optional(),
  manufacturer: z.string().trim().min(1).max(200).optional(),
  manufacturerName: z.string().trim().min(1).max(200).optional(),
  modelIdentifier: z.string().trim().min(1).max(120).optional(),
  model: z.string().trim().min(1).max(120).optional(),
});

export type PublicProductLookupQuery = z.infer<typeof publicProductLookupQuerySchema>;

export const publicDateCommitmentSchema = z.object({
  value: z.string().nullable(),
  displayValue: z.string(),
  precision: z.enum(['day', 'month', 'year']),
});

export const publicSourceItemSchema = z.object({
  url: z.string().url(),
  domain: z.string(),
  title: z.string().nullable(),
  lastRetrieved: z.string().nullable(),
});

export const publicClaimItemSchema = z.object({
  id: z.string().uuid(),
  claimType: z.enum(['support_start', 'support_end', 'os_version', 'policy']),
  statement: z.string(),
  quotation: z.string(),
  dateText: z.string().nullable(),
  datePrecision: z.enum(['day', 'month', 'year']).nullable(),
  normalizedDate: z.string().nullable(),
  source: publicSourceItemSchema.nullable(),
  reviewStatus: z.literal('accepted'),
});

export const publicSupportInformationSchema = z.object({
  status: z.enum(['INFORMATION_AVAILABLE', 'CONFLICTING_INFORMATION', 'INSUFFICIENT_INFORMATION']),
  summaryStatement: z.string(),
  disclaimer: z.string(),
  supportStart: publicDateCommitmentSchema.nullable(),
  supportEnd: publicDateCommitmentSchema.nullable(),
  operatingSystems: z.array(z.string()),
  policyStatements: z.array(z.string()),
  claims: z.array(publicClaimItemSchema),
  sources: z.array(publicSourceItemSchema),
});

export const publicProductDetailsSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  manufacturer: z.object({
    id: z.string().uuid(),
    name: z.string(),
    website: z.string().nullable(),
    countryCode: z.string().nullable(),
  }),
  modelIdentifier: z.string().nullable(),
  gtin: z.string().nullable(),
  category: z.string().nullable(),
  productUrl: z.string().nullable(),
});

export const publicSupportCardResponseSchema = z.object({
  data: z.object({
    product: publicProductDetailsSchema,
    supportInformation: publicSupportInformationSchema,
    lastUpdated: z.string(),
  }),
});

export const publicProductLookupResponseSchema = z.object({
  data: z.object({
    product: publicProductDetailsSchema,
    supportCardUrl: z.string(),
  }),
});

export type PublicDateCommitment = z.infer<typeof publicDateCommitmentSchema>;
export type PublicSourceItem = z.infer<typeof publicSourceItemSchema>;
export type PublicClaimItem = z.infer<typeof publicClaimItemSchema>;
export type PublicSupportInformation = z.infer<typeof publicSupportInformationSchema>;
export type PublicProductDetails = z.infer<typeof publicProductDetailsSchema>;
export type PublicSupportCardResponse = z.infer<typeof publicSupportCardResponseSchema>;
export type PublicProductLookupResponse = z.infer<typeof publicProductLookupResponseSchema>;

