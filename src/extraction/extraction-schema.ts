import { z } from 'zod';

/**
 * Schema for the model's JSON response. Unknown keys are stripped, but the
 * required fields are strictly validated: the extraction service never trusts
 * model output without this step.
 */

export const claimTypeSchema = z
  .string()
  .transform((val) => {
    const v = val.toLowerCase().trim().replace(/[\s-]+/g, '_');
    if (v === 'support_start' || v.startsWith('support_start')) return 'support_start';
    if (v === 'support_end' || v.startsWith('support_end')) return 'support_end';
    if (
      v === 'os_version' ||
      v.includes('os_version') ||
      v.includes('operating_system')
    ) {
      return 'os_version';
    }
    if (v === 'policy' || v.includes('policy')) return 'policy';
    // SERV often returns prose labels such as "support ends or expires".
    if (v.includes('support') && /(?:^|_)start|begin|begins/.test(v)) return 'support_start';
    if (v.includes('support') && /end|ends|ending|expire|expires|expiry|eol/.test(v)) {
      return 'support_end';
    }
    if (v.includes('support') && /duration|policy|period|commitment/.test(v)) return 'policy';
    return v;
  })
  .pipe(z.enum(['support_start', 'support_end', 'os_version', 'policy']));

export const datePrecisionSchema = z.enum(['day', 'month', 'year']);

export const MAX_CLAIMS_PER_SOURCE = 20;
export const MAX_STATEMENT_CHARS = 2_000;
export const MAX_QUOTATION_CHARS = 4_000;
export const MAX_DATE_TEXT_CHARS = 200;
export const MAX_EXPLANATION_CHARS = 2_000;

export const confidenceSchema = z
  .union([z.number(), z.string()])
  .transform((val) => {
    if (typeof val === 'number') return val;
    const num = parseFloat(val);
    if (!Number.isNaN(num)) return num;
    const lower = val.toLowerCase().trim();
    if (lower === 'high') return 0.95;
    if (lower === 'medium') return 0.7;
    if (lower === 'low') return 0.4;
    return 0.5;
  })
  .pipe(z.number().min(0).max(1));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * SERV sometimes uses descriptive field names such as `supported_claim`,
 * `source_quote` and `claim_type`. Normalise those before strict validation;
 * values are still checked against the source exactly as before.
 */
function normalizeClaimFields(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    claimType: value.claimType ?? value.claim_type,
    statement:
      value.statement ??
      value.supported_statement ??
      value.supported_claim ??
      value.supporting_statement ??
      value.claim,
    quotation:
      value.quotation ??
      value.evidence ??
      value.quote ??
      value.source_quote ??
      value.supporting_quote ??
      value.support_quote ??
      value.verbatim_quote ??
      value.verbatim_text ??
      value.quote_text,
    dateText: value.dateText ?? value.date_text ?? value.source_date ?? value.date,
  };
}

export const aiClaimSchema = z
  .preprocess(normalizeClaimFields, z.object({
    claimType: z.string().optional(),
    statement: z.string().trim().min(1).max(MAX_STATEMENT_CHARS),
    quotation: z.string().trim().max(MAX_QUOTATION_CHARS).nullish(),
    dateText: z.string().trim().max(MAX_DATE_TEXT_CHARS).nullish(),
    confidence: confidenceSchema,
    explanation: z
      .string()
      .trim()
      .max(MAX_EXPLANATION_CHARS)
      .nullish()
      .transform((value) => value ?? ''),
  })
  .transform((val) => {
    const quotation = (val.quotation ?? '').trim();
    const rawDate = val.dateText;
    const dateText = rawDate && rawDate.trim().length > 0 ? rawDate.trim() : null;
    return {
      claimType: claimTypeSchema.parse(val.claimType ?? 'support_end'),
      statement: val.statement,
      quotation,
      dateText,
      confidence: val.confidence,
      explanation: val.explanation,
    };
  }));

export const aiExtractionResponseSchema = z.object({
  claims: z.array(aiClaimSchema).max(MAX_CLAIMS_PER_SOURCE),
});

/**
 * JSON schema specification for models supporting json_schema structured outputs.
 */
export const EXTRACTION_JSON_SCHEMA = {
  name: 'ss_tool_evidence_extraction',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      claims: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            claimType: {
              type: 'string',
              enum: ['support_start', 'support_end', 'os_version', 'policy'],
            },
            statement: { type: 'string' },
            quotation: { type: 'string' },
            dateText: { type: ['string', 'null'] },
            confidence: { type: 'number' },
            explanation: { type: 'string' },
          },
          required: ['claimType', 'statement', 'quotation', 'dateText', 'confidence', 'explanation'],
          additionalProperties: false,
        },
      },
    },
    required: ['claims'],
    additionalProperties: false,
  },
};

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
export function parseAiExtractionResponse(
  text: string,
  options: { sourceContent?: string } = {},
): AiExtractionResponse {
  const json = extractJsonObject(text);
  const parsed = aiExtractionResponseSchema.safeParse(json);

  if (!parsed.success) {
    throw new ExtractionOutputError('INVALID_SCHEMA', 'AI response did not match the extraction schema', {
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
      ),
    });
  }

  const issues: string[] = [];
  for (const [index, claim] of parsed.data.claims.entries()) {
    if (claim.quotation.length > 0) continue;

    // Some OpenAI-compatible models omit "quotation" even when instructed.
    // Only recover it when the statement itself is verbatim source text; never
    // paraphrase on the model's behalf.
    if (options.sourceContent && options.sourceContent.includes(claim.statement)) {
      claim.quotation = claim.statement;
      continue;
    }

    issues.push(
      `claims.${index}.quotation: quotation must not be empty and the statement did not match the source verbatim`,
    );
  }

  if (issues.length > 0) {
    throw new ExtractionOutputError('INVALID_SCHEMA', 'AI response did not match the extraction schema', {
      issues,
    });
  }

  return parsed.data;
}
