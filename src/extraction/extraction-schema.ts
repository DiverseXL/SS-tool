import { z } from 'zod';

/**
 * Schema for the model's JSON response. Unknown keys are stripped, but the
 * required fields are strictly validated: the extraction service never trusts
 * model output without this step.
 */

export const claimTypeSchema = z.enum(['support_start', 'support_end', 'os_version', 'policy']);

export const datePrecisionSchema = z.enum(['day', 'month', 'year']);

export const MAX_CLAIMS_PER_SOURCE = 20;
export const MAX_STATEMENT_CHARS = 2_000;
export const MAX_QUOTATION_CHARS = 4_000;
export const MAX_DATE_TEXT_CHARS = 200;
export const MAX_EXPLANATION_CHARS = 2_000;

export const aiClaimSchema = z.object({
  claimType: claimTypeSchema,
  statement: z.string().trim().min(1).max(MAX_STATEMENT_CHARS),
  quotation: z.string().trim().min(1).max(MAX_QUOTATION_CHARS),
  // The AI may omit this or return null when the claim has no explicit date.
  dateText: z
    .string()
    .trim()
    .max(MAX_DATE_TEXT_CHARS)
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null)),
  confidence: z.number().min(0).max(1),
  explanation: z
    .string()
    .trim()
    .max(MAX_EXPLANATION_CHARS)
    .nullish()
    .transform((value) => value ?? ''),
});

export const aiExtractionResponseSchema = z.object({
  claims: z.array(aiClaimSchema).max(MAX_CLAIMS_PER_SOURCE),
});

export type AiClaim = z.infer<typeof aiClaimSchema>;
export type AiExtractionResponse = z.infer<typeof aiExtractionResponseSchema>;

export type ExtractionOutputErrorCode = 'MALFORMED_JSON' | 'INVALID_SCHEMA';

/**
 * Raised when a model response cannot be parsed or validated. The message is
 * deliberately limited to structural information: no model output is echoed.
 */
export class ExtractionOutputError extends Error {
  readonly code: ExtractionOutputErrorCode;
  readonly issues?: string[];

  constructor(
    code: ExtractionOutputErrorCode,
    message: string,
    options: { issues?: string[] } = {},
  ) {
    super(message);
    this.name = 'ExtractionOutputError';
    this.code = code;
    if (options.issues) this.issues = options.issues;
  }
}

/**
 * Extracts the JSON object from a completion. Some OpenAI-compatible models
 * wrap JSON in markdown fences despite `response_format`, so fences and
 * leading/trailing prose are tolerated before strict schema validation.
 */
export function extractJsonObject(text: string): unknown {
  let candidate = text.trim();

  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(candidate);
  if (fenced?.[1]) {
    candidate = fenced[1].trim();
  }

  if (!candidate.startsWith('{')) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      candidate = candidate.slice(start, end + 1);
    }
  }

  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    throw new ExtractionOutputError('MALFORMED_JSON', 'AI response was not valid JSON');
  }
}

/**
 * Parses and validates a completion. The returned claims are still untrusted:
 * quotations, dates and claim semantics are checked against the source by the
 * extraction service.
 */
export function parseAiExtractionResponse(text: string): AiExtractionResponse {
  const json = extractJsonObject(text);
  const parsed = aiExtractionResponseSchema.safeParse(json);

  if (!parsed.success) {
    throw new ExtractionOutputError('INVALID_SCHEMA', 'AI response did not match the extraction schema', {
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
      ),
    });
  }

  return parsed.data;
}
