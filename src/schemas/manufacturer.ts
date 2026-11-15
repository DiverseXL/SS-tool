import { z } from 'zod';

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

export const httpUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(isHttpUrl, 'must be a valid http:// or https:// URL');

/** Trims optional free text and treats an empty string as "not provided". */
export function optionalText(maxLength: number) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .optional()
    .transform((value) => (value ? value : undefined));
}

export const createManufacturerBodySchema = z
  .object({
    name: z.string().trim().min(1, 'is required').max(200),
    website: httpUrlSchema.optional(),
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, 'must be a two-letter country code')
      .transform((value) => value.toUpperCase())
      .optional(),
  })
  .strict();

export type CreateManufacturerBody = z.infer<typeof createManufacturerBodySchema>;
