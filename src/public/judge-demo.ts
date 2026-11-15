import { AppError } from '../lib/errors.js';
import type { PublicDateCommitment, PublicSupportInformation } from '../schemas/public.js';
import { validateClaimSemantics } from '../extraction/claim-guards.js';
import { analyzeDateText, dateTextSupportedByQuotation } from '../extraction/date-normalizer.js';
import { buildExtractionPrompt } from '../extraction/extraction-prompt.js';
import {
  ExtractionOutputError,
  parseAiExtractionResponse,
} from '../extraction/extraction-schema.js';
import {
  AiProviderError,
  describeProviderFailure,
  type AiProvider,
} from '../extraction/provider.js';
import { validateQuotation } from '../extraction/quotation-validator.js';
import { DEMO_PRODUCTS } from './demo-dataset.js';
import {
  DEMO_EXTRACTION_PRODUCTS,
  findDemoExtractionProduct,
  type DemoExtractionProduct,
} from './demo-extract-products.js';
import type { PublicService } from './public-service.js';

export interface JudgeDemoProductSummary {
  id: string;
  name: string;
  manufacturer: string;
  modelIdentifier: string | null;
  category: string | null;
  status: PublicSupportInformation['status'];
  summaryStatement: string;
  supportStart: PublicDateCommitment | null;
  supportEnd: PublicDateCommitment | null;
  claimCount: number;
  sourceCount: number;
  lastUpdated: string;
  demonstration: true;
}

export interface DemoExtractionClaimItem {
  claimType: string;
  statement: string;
  quotation: string;
  dateText: string | null;
  datePrecision: string | null;
  normalizedDate: string | null;
  confidence: number;
  explanation: string;
  reviewStatus: 'pending';
  validation: {
    quotationMatched: boolean;
    dateSupportedInQuotation: boolean;
    semanticsValid: boolean;
    rejectionReason?: string;
  };
}

export interface DemoExtractionResult {
  demonstration: true;
  isLiveExtraction: true;
  provider: string;
  model: string;
  requestId: string | null;
  durationMs: number;
  usage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  } | null;
  product: {
    id: string;
    name: string;
    manufacturer: string;
    modelIdentifier: string;
    category: string;
  };
  source: {
    url: string;
    title: string;
    excerpt: string;
  };
  claims: DemoExtractionClaimItem[];
  disclaimer: string;
}

// In-memory rate limiting: max 10 live demo executions per 60 seconds per IP.
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 10;
const requestLog = new Map<string, number[]>();

function checkRateLimit(clientIp: string): void {
  const now = Date.now();

  // Drop expired buckets periodically so the map cannot grow without bound.
  if (requestLog.size > 1_000) {
    for (const [ip, times] of requestLog) {
      if (times.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) requestLog.delete(ip);
    }
  }

  const timestamps = (requestLog.get(clientIp) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS,
  );

  if (timestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    throw new AppError(
      429,
      'RATE_LIMIT_EXCEEDED',
      'Demonstration rate limit exceeded. Please wait a minute before running another AI extraction.',
    );
  }

  timestamps.push(now);
  requestLog.set(clientIp, timestamps);
}

export interface JudgeDemoService {
  listDemoProducts(): Promise<JudgeDemoProductSummary[]>;
  listExtractionProducts(): DemoExtractionProduct[];
  runDemoExtraction(params: {
    demoProductId: string;
    clientIp?: string;
  }): Promise<DemoExtractionResult>;
}

/**
 * Read-only projection over the existing public support-card service, plus the
 * live SERV preview used by the landing-page judge panel.
 *
 * The preview only references fixed server-side demo products, never persists
 * claims and never accepts client-supplied source URLs or text. The support
 * card projection never queries private evidence tables and never exposes
 * pending/rejected records.
 */
export function createJudgeDemoService(
  publicService: Pick<PublicService, 'getSupportCard'>,
  provider: AiProvider | null = null,
): JudgeDemoService {
  return {
    async listDemoProducts() {
      const products: JudgeDemoProductSummary[] = [];

      for (const demoProduct of DEMO_PRODUCTS) {
        try {
          const card = await publicService.getSupportCard(demoProduct.id);
          products.push({
            id: card.product.id,
            name: card.product.name,
            manufacturer: card.product.manufacturer.name,
            modelIdentifier: card.product.modelIdentifier,
            category: card.product.category,
            status: card.supportInformation.status,
            summaryStatement: card.supportInformation.summaryStatement,
            supportStart: card.supportInformation.supportStart,
            supportEnd: card.supportInformation.supportEnd,
            claimCount: card.supportInformation.claims.length,
            sourceCount: card.supportInformation.sources.length,
            lastUpdated: card.lastUpdated,
            demonstration: true,
          });
        } catch (error) {
          if (error instanceof AppError && error.code === 'PRODUCT_NOT_FOUND') {
            continue;
          }
          throw error;
        }
      }

      return products;
    },

    listExtractionProducts() {
      return DEMO_EXTRACTION_PRODUCTS;
    },

    async runDemoExtraction({ demoProductId, clientIp = '127.0.0.1' }) {
      const demoProduct = findDemoExtractionProduct(demoProductId);
      if (!demoProduct) {
        throw new AppError(
          400,
          'INVALID_DEMO_PRODUCT',
          `Unknown demonstration product "${demoProductId}". Only predefined demonstration products are allowed.`,
        );
      }

      if (!provider) {
        throw new AppError(
          503,
          'AI_NOT_CONFIGURED',
          'OpenServ SERV AI provider is not configured. Set SERV_API_KEY in the environment to enable live AI demonstration.',
        );
      }

      // The panel presents the result as an OpenServ SERV extraction, so never
      // silently run it against a different OpenAI-compatible provider.
      if (!provider.isServ) {
        throw new AppError(
          503,
          'SERV_NOT_CONFIGURED',
          'The judge demonstration requires the OpenServ SERV provider. Set SERV_API_KEY to enable it.',
        );
      }

      // Only genuine extraction attempts consume the per-IP budget.
      checkRateLimit(clientIp);

      const prompt = buildExtractionPrompt(
        {
          url: demoProduct.source.url,
          title: demoProduct.source.title,
          relationshipType: 'support_page',
          manufacturerName: demoProduct.manufacturer,
          productName: demoProduct.name,
          modelIdentifier: demoProduct.modelIdentifier,
          marketRegion: 'Global',
        },
        demoProduct.source.contentText,
        8_000,
      );

      let completion;
      try {
        completion = await provider.complete({
          systemPrompt: prompt.systemPrompt,
          userPrompt: prompt.userPrompt,
          maxOutputTokens: 1_500,
          temperature: 0.1,
        });
      } catch (error) {
        if (error instanceof AiProviderError) {
          const failure = describeProviderFailure(error);
          throw new AppError(failure.statusCode, failure.code, failure.message);
        }
        throw error;
      }

      let parsed;
      try {
        parsed = parseAiExtractionResponse(completion.text, {
          sourceContent: demoProduct.source.contentText,
        });
      } catch (error) {
        if (error instanceof ExtractionOutputError) {
          throw new AppError(
            502,
            'AI_RESPONSE_INVALID',
            error.code === 'MALFORMED_JSON'
              ? 'The AI provider returned output that was not valid JSON. No claims were accepted.'
              : 'The AI provider returned output that did not match the extraction schema. No claims were accepted.',
          );
        }
        throw error;
      }

      const claimsWithValidation: DemoExtractionClaimItem[] = [];

      for (const claim of parsed.claims) {
        const quotationValidation = validateQuotation(
          claim.quotation,
          demoProduct.source.contentText,
        );

        const date = analyzeDateText(claim.dateText);
        const dateSupported =
          !date.dateText || dateTextSupportedByQuotation(date.dateText, claim.quotation);

        const semanticRejection = validateClaimSemantics(
          claim.claimType,
          claim.quotation,
          date.dateText,
        );

        const rejectionReason = !quotationValidation.matched
          ? (quotationValidation.reason ?? 'quotation_not_found')
          : !dateSupported
            ? 'date_text_not_in_quotation'
            : semanticRejection
              ? semanticRejection.code
              : undefined;

        claimsWithValidation.push({
          claimType: claim.claimType,
          statement: claim.statement,
          quotation: claim.quotation,
          dateText: date.dateText,
          datePrecision: date.precision,
          normalizedDate: date.normalizedDate,
          confidence: claim.confidence,
          explanation: claim.explanation,
          reviewStatus: 'pending',
          validation: {
            quotationMatched: quotationValidation.matched,
            dateSupportedInQuotation: dateSupported,
            semanticsValid: !semanticRejection,
            ...(rejectionReason ? { rejectionReason } : {}),
          },
        });
      }

      return {
        demonstration: true,
        isLiveExtraction: true,
        provider: 'OpenServ SERV',
        model: completion.model,
        requestId: completion.requestId ?? null,
        durationMs: completion.durationMs ?? 0,
        usage: completion.usage
          ? {
              promptTokens: completion.usage.inputTokens,
              completionTokens: completion.usage.outputTokens,
              totalTokens: completion.usage.totalTokens,
            }
          : null,
        product: {
          id: demoProduct.id,
          name: demoProduct.name,
          manufacturer: demoProduct.manufacturer,
          modelIdentifier: demoProduct.modelIdentifier,
          category: demoProduct.category,
        },
        source: {
          url: demoProduct.source.url,
          title: demoProduct.source.title,
          excerpt:
            demoProduct.source.contentText.length > 300
              ? `${demoProduct.source.contentText.slice(0, 300)}…`
              : demoProduct.source.contentText,
        },
        claims: claimsWithValidation,
        disclaimer:
          'This demonstration runs a live OpenServ SERV Reasoning extraction over predefined demonstration source text. Claims are previews: nothing is stored, and every claim remains pending human review.',
      };
    },
  };
}
