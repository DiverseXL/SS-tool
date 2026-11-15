import type { ClaimType, SourceRelationshipType } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import type { ProductRepository } from '../repositories/product-repository.js';
import type {
  EvidenceRepository,
  ProductSourceForExtraction,
} from '../repositories/evidence-repository.js';
import { isManufacturerDomain, validateClaimSemantics } from './claim-guards.js';
import { createClaimFingerprint } from './claim-fingerprint.js';
import { analyzeDateText, dateTextSupportedByQuotation } from './date-normalizer.js';
import { buildExtractionPrompt } from './extraction-prompt.js';
import {
  ExtractionOutputError,
  parseAiExtractionResponse,
  type AiClaim,
} from './extraction-schema.js';
import {
  AiProviderError,
  DEFAULT_AI_MAX_INPUT_TOKENS,
  DEFAULT_AI_MAX_OUTPUT_TOKENS,
  describeProviderFailure,
  maxInputChars,
  type AiProvider,
} from './provider.js';
import { normalizeQuotationText, validateQuotation } from './quotation-validator.js';

export const MAX_SOURCES_PER_EXTRACTION = 5;

const DEFAULT_TEMPERATURE = 0.1;

const RELATIONSHIP_PRIORITY: Record<SourceRelationshipType, number> = {
  security_advisory: 0,
  policy_page: 1,
  support_page: 2,
  product_page: 3,
  manufacturer_homepage: 4,
  discovered_candidate: 5,
};

export interface ExtractionServiceOptions {
  products: ProductRepository;
  evidence: EvidenceRepository;
  /** Null when the environment does not configure an AI provider. */
  provider: AiProvider | null;
  /** Safe, human-readable explanation of missing configuration. */
  configurationError?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
  logger?: {
    info: (fields: object, message?: string) => void;
    warn: (fields: object, message?: string) => void;
  };
}

export interface StoredClaimSummary {
  evidenceId: string;
  sourceId: string;
  claimType: ClaimType;
  statement: string;
  quotation: string;
  dateText: string | null;
  datePrecision: 'day' | 'month' | 'year' | null;
  normalizedDate: string | null;
  reviewStatus: 'pending';
  confidence: number;
  explanation: string;
}

export interface RejectedClaimSummary {
  sourceId: string;
  claimType: ClaimType;
  statement: string;
  reason: string;
  message: string;
}

export interface DuplicateClaimSummary {
  sourceId: string;
  claimType: ClaimType;
  existingEvidenceId: string | null;
  reason: 'duplicate_claim';
}

export interface SkippedSourceSummary {
  sourceId: string;
  url: string;
  reason:
    | 'discovered_candidate'
    | 'empty_content'
    | 'not_successfully_fetched'
    | 'third_party_source'
    | 'source_limit';
}

export interface ExtractionFailureSummary {
  sourceId: string;
  url: string;
  reason: 'malformed_ai_json' | 'invalid_ai_schema';
  message: string;
}

export interface ProcessedSourceSummary {
  sourceId: string;
  url: string;
  title: string | null;
  relationshipType: SourceRelationshipType;
  charactersSent: number;
}

export interface ExtractionObservability {
  requestId?: string;
  durationMs?: number;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  isServ?: boolean;
}

export interface ExtractionResult {
  productId: string;
  extractedAt: string;
  provider: string;
  sourcesProcessed: number;
  sourcesSkipped: number;
  claimsExtracted: number;
  claimsStored: number;
  claimsRejected: number;
  duplicateClaims: number;
  extractionFailures: ExtractionFailureSummary[];
  sources: ProcessedSourceSummary[];
  skippedSources: SkippedSourceSummary[];
  storedClaims: StoredClaimSummary[];
  rejectedClaims: RejectedClaimSummary[];
  duplicates: DuplicateClaimSummary[];
  limits: {
    maxSources: number;
    maxInputTokens: number;
    maxOutputTokens: number;
  };
  metadata?: ExtractionObservability;
}

export interface ExtractionService {
  extract(productId: string): Promise<ExtractionResult>;
}

interface AssociatedSource {
  source: ProductSourceForExtraction;
  roles: SourceRelationshipType[];
  /** Best (most specific) non-candidate role. */
  primaryRole: SourceRelationshipType;
}

function pickPrimaryRole(roles: SourceRelationshipType[]): SourceRelationshipType {
  return [...roles].sort(
    (left, right) => RELATIONSHIP_PRIORITY[left] - RELATIONSHIP_PRIORITY[right],
  )[0] as SourceRelationshipType;
}

function groupAssociations(
  associations: ProductSourceForExtraction[],
): Map<string, AssociatedSource> {
  const grouped = new Map<string, AssociatedSource>();

  for (const association of associations) {
    const existing = grouped.get(association.sourceId);
    if (existing) {
      if (!existing.roles.includes(association.relationshipType)) {
        existing.roles.push(association.relationshipType);
      }
      existing.primaryRole = pickPrimaryRole(existing.roles);
      continue;
    }

    grouped.set(association.sourceId, {
      source: association,
      roles: [association.relationshipType],
      primaryRole: association.relationshipType,
    });
  }

  return grouped;
}

function isSuccessfullyFetched(source: ProductSourceForExtraction): boolean {
  return (
    source.httpStatus !== null && source.httpStatus >= 200 && source.httpStatus <= 299
  );
}

function hasContent(source: ProductSourceForExtraction): boolean {
  return typeof source.contentText === 'string' && source.contentText.trim().length > 0;
}

/**
 * Selects at most five relevant, successfully fetched manufacturer sources.
 * External candidates and contentless records are always excluded.
 */
function selectSources(
  associations: ProductSourceForExtraction[],
  manufacturerWebsite: string | null,
  maxSources: number,
): { selected: AssociatedSource[]; skipped: SkippedSourceSummary[] } {
  const skipped: SkippedSourceSummary[] = [];
  const candidates: AssociatedSource[] = [];

  for (const entry of groupAssociations(associations).values()) {
    const { source } = entry;
    const skip = (reason: SkippedSourceSummary['reason']): void => {
      skipped.push({ sourceId: source.sourceId, url: source.url, reason });
    };

    if (entry.primaryRole === 'discovered_candidate') {
      skip('discovered_candidate');
      continue;
    }

    if (!isSuccessfullyFetched(source)) {
      skip('not_successfully_fetched');
      continue;
    }

    if (!hasContent(source)) {
      skip('empty_content');
      continue;
    }

    if (!isManufacturerDomain(source.domain, manufacturerWebsite)) {
      skip('third_party_source');
      continue;
    }

    candidates.push(entry);
  }

  candidates.sort((left, right) => {
    const byRole =
      RELATIONSHIP_PRIORITY[left.primaryRole] - RELATIONSHIP_PRIORITY[right.primaryRole];
    if (byRole !== 0) return byRole;

    const leftFetched = left.source.fetchedAt?.getTime() ?? 0;
    const rightFetched = right.source.fetchedAt?.getTime() ?? 0;
    if (leftFetched !== rightFetched) return rightFetched - leftFetched;

    return left.source.url.localeCompare(right.source.url);
  });

  const selected = candidates.slice(0, maxSources);
  for (const entry of candidates.slice(maxSources)) {
    skipped.push({
      sourceId: entry.source.sourceId,
      url: entry.source.url,
      reason: 'source_limit',
    });
  }

  return { selected, skipped };
}

function claimSummaryKey(claimType: ClaimType, quotation: string): string {
  return `${claimType}\u0000${normalizeQuotationText(quotation)}`;
}

export function createExtractionService(
  options: ExtractionServiceOptions,
): ExtractionService {
  const {
    products,
    evidence,
    provider,
    configurationError,
    logger,
  } = options;
  const maxInputTokens = options.maxInputTokens ?? DEFAULT_AI_MAX_INPUT_TOKENS;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_AI_MAX_OUTPUT_TOKENS;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  const maxSources = MAX_SOURCES_PER_EXTRACTION;

  return {
    async extract(productId) {
      const detail = await products.findDetailById(productId);
      if (!detail) {
        throw AppError.notFound('PRODUCT_NOT_FOUND', 'Product not found');
      }

      if (!provider) {
        throw new AppError(
          503,
          'AI_NOT_CONFIGURED',
          configurationError
            ? `AI provider is not configured (${configurationError})`
            : 'AI provider is not configured. Set AI_BASE_URL, AI_API_KEY and AI_MODEL to enable extraction.',
        );
      }

      const { product, manufacturer } = detail;
      const associations = await evidence.findSourcesForProduct(productId);
      const { selected, skipped } = selectSources(
        associations,
        manufacturer.website,
        maxSources,
      );

      const result: ExtractionResult = {
        productId,
        extractedAt: new Date().toISOString(),
        provider: provider.name,
        sourcesProcessed: 0,
        sourcesSkipped: skipped.length,
        claimsExtracted: 0,
        claimsStored: 0,
        claimsRejected: 0,
        duplicateClaims: 0,
        extractionFailures: [],
        sources: [],
        skippedSources: skipped,
        storedClaims: [],
        rejectedClaims: [],
        duplicates: [],
        limits: { maxSources, maxInputTokens, maxOutputTokens },
      };

      // Claims seen earlier in this same run, used to avoid duplicate inserts
      // before the database conflict check is reached.
      const seenInRun = new Set<string>();

      for (const entry of selected) {
        const { source, primaryRole } = entry;

        result.sourcesProcessed += 1;

        const prompt = buildExtractionPrompt(
          {
            url: source.url,
            title: source.title,
            relationshipType: primaryRole,
            manufacturerName: manufacturer.name,
            productName: product.name,
            modelIdentifier: product.modelIdentifier,
            marketRegion: product.marketRegion,
          },
          source.contentText ?? '',
          maxInputChars(maxInputTokens),
        );

        result.sources.push({
          sourceId: source.sourceId,
          url: source.url,
          title: source.title,
          relationshipType: primaryRole,
          charactersSent: prompt.userPrompt.length,
        });

        let completion;
        try {
          completion = await provider.complete({
            systemPrompt: prompt.systemPrompt,
            userPrompt: prompt.userPrompt,
            maxOutputTokens,
            temperature,
          });
        } catch (error) {
          if (error instanceof AiProviderError) {
            const failure = describeProviderFailure(error);
            logger?.warn(
              { sourceId: source.sourceId, provider: provider.name, code: error.code },
              'AI provider request failed during extraction',
            );
            throw new AppError(failure.statusCode, failure.code, failure.message);
          }
          throw error;
        }

        if (completion.requestId || completion.durationMs !== undefined || completion.usage) {
          result.metadata = {
            requestId: completion.requestId,
            durationMs: completion.durationMs,
            usage: completion.usage
              ? {
                  promptTokens: completion.usage.inputTokens,
                  completionTokens: completion.usage.outputTokens,
                  totalTokens: completion.usage.totalTokens,
                }
              : undefined,
            isServ: provider.isServ,
          };
        }

        logger?.info(
          {
            sourceId: source.sourceId,
            provider: provider.name,
            durationMs: completion.durationMs,
            requestId: completion.requestId,
            usage: completion.usage,
          },
          'AI provider completion received',
        );

        let claims: AiClaim[];
        try {
          const parsed = parseAiExtractionResponse(completion.text, {
            sourceContent: source.contentText ?? '',
          });
          claims = parsed.claims;
        } catch (error) {
          if (error instanceof ExtractionOutputError) {
            result.extractionFailures.push({
              sourceId: source.sourceId,
              url: source.url,
              reason: error.code === 'MALFORMED_JSON' ? 'malformed_ai_json' : 'invalid_ai_schema',
              message: error.message,
            });
            logger?.warn(
              { sourceId: source.sourceId, provider: provider.name, code: error.code },
              'AI extraction output rejected',
            );
            continue;
          }
          throw error;
        }

        result.claimsExtracted += claims.length;

        for (const claim of claims) {
          const reject = (reason: string, message: string): void => {
            result.claimsRejected += 1;
            result.rejectedClaims.push({
              sourceId: source.sourceId,
              claimType: claim.claimType,
              statement: claim.statement,
              reason,
              message,
            });
          };

          const quotationValidation = validateQuotation(
            claim.quotation,
            source.contentText ?? '',
          );
          if (!quotationValidation.matched) {
            reject(
              quotationValidation.reason ?? 'quotation_not_found_in_source',
              'The quotation could not be traced to the stored source content',
            );
            continue;
          }

          const date = analyzeDateText(claim.dateText);
          if (date.dateText && !dateTextSupportedByQuotation(date.dateText, claim.quotation)) {
            reject(
              'date_text_not_in_quotation',
              'The stated date text does not appear in the supporting quotation',
            );
            continue;
          }

          const semanticRejection = validateClaimSemantics(
            claim.claimType,
            claim.quotation,
            date.dateText,
          );
          if (semanticRejection) {
            reject(semanticRejection.code, semanticRejection.message);
            continue;
          }

          const confidence = Math.round(Math.min(1, Math.max(0, claim.confidence)) * 1_000) / 1_000;
          const fingerprint = createClaimFingerprint({
            productId,
            sourceId: source.sourceId,
            claimType: claim.claimType,
            quotation: claim.quotation,
            dateText: date.dateText,
          });

          const runKey = `${claimSummaryKey(claim.claimType, claim.quotation)}\u0000${fingerprint}`;
          if (seenInRun.has(runKey)) {
            result.duplicateClaims += 1;
            result.duplicates.push({
              sourceId: source.sourceId,
              claimType: claim.claimType,
              existingEvidenceId: null,
              reason: 'duplicate_claim',
            });
            continue;
          }
          seenInRun.add(runKey);

          // Check all existing evidence for this source/type, including manual
          // and already-reviewed rows. Reviewed evidence is never modified.
          const existingClaims = await evidence.findClaimsForSource(
            productId,
            source.sourceId,
            claim.claimType,
          );
          const duplicate = existingClaims.find(
            (existing) =>
              normalizeQuotationText(existing.quotedExcerpt) ===
              normalizeQuotationText(claim.quotation),
          );

          if (duplicate) {
            result.duplicateClaims += 1;
            result.duplicates.push({
              sourceId: source.sourceId,
              claimType: claim.claimType,
              existingEvidenceId: duplicate.id,
              reason: 'duplicate_claim',
            });
            continue;
          }

          const stored = await evidence.insertAiEvidence({
            productId,
            sourceId: source.sourceId,
            claimType: claim.claimType,
            rawText: claim.statement,
            dateText: date.dateText,
            datePrecision: date.precision,
            normalizedDate: date.normalizedDate,
            quotedExcerpt: claim.quotation,
            confidence,
            explanation: claim.explanation,
            claimFingerprint: fingerprint,
          });

          if (!stored) {
            // Lost a race or matched the partial unique fingerprint index.
            result.duplicateClaims += 1;
            result.duplicates.push({
              sourceId: source.sourceId,
              claimType: claim.claimType,
              existingEvidenceId: null,
              reason: 'duplicate_claim',
            });
            continue;
          }

          result.claimsStored += 1;
          result.storedClaims.push({
            evidenceId: stored.id,
            sourceId: source.sourceId,
            claimType: stored.claimType,
            statement: stored.rawText,
            quotation: stored.quotedExcerpt,
            dateText: stored.dateText,
            datePrecision: stored.datePrecision,
            normalizedDate: stored.normalizedDate,
            reviewStatus: 'pending',
            confidence: stored.confidence ?? confidence,
            explanation: stored.explanation ?? '',
          });
        }
      }

      logger?.info(
        {
          productId,
          sourcesProcessed: result.sourcesProcessed,
          sourcesSkipped: result.sourcesSkipped,
          claimsExtracted: result.claimsExtracted,
          claimsStored: result.claimsStored,
          claimsRejected: result.claimsRejected,
          duplicateClaims: result.duplicateClaims,
          extractionFailures: result.extractionFailures.length,
        },
        'evidence extraction completed',
      );

      return result;
    },
  };
}
