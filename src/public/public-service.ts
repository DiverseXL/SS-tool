import { AppError } from '../lib/errors.js';
import { isValidGtin } from '../lib/gtin.js';
import type { EvidenceRepository } from '../repositories/evidence-repository.js';
import type { ProductRepository, ProductWithManufacturer } from '../repositories/product-repository.js';
import type { SourceRepository } from '../repositories/source-repository.js';
import {
  publicProductLookupResponseSchema,
  publicSupportCardResponseSchema,
  type PublicClaimItem,
  type PublicDateCommitment,
  type PublicProductDetails,
  type PublicProductLookupQuery,
  type PublicProductLookupResponse,
  type PublicSourceItem,
  type PublicSupportCardResponse,
  type PublicSupportInformation,
} from '../schemas/public.js';
import { detectConflicts } from '../verification/conflict-detector.js';

export interface PublicServiceDependencies {
  products: ProductRepository;
  evidence: EvidenceRepository;
  sources: SourceRepository;
}

export interface PublicService {
  getSupportCard(productId: string): Promise<PublicSupportCardResponse['data']>;
  lookupProduct(query: PublicProductLookupQuery): Promise<PublicProductLookupResponse['data']>;
}

const PUBLIC_DISCLAIMER =
  'This support card reflects manufacturer-published statements reviewed by SS Tool. It does not certify security, guarantee update delivery, or verify compliance.';

export function createPublicService(deps: PublicServiceDependencies): PublicService {
  const { products, evidence } = deps;

  return {
    async getSupportCard(productId: string) {
      const productDetail = await products.findDetailById(productId);
      if (!productDetail) {
        throw AppError.notFound('PRODUCT_NOT_FOUND', 'Product not found');
      }

      const { product, manufacturer } = productDetail;

      // Retrieve all evidence associated with this product
      const allEvidenceWithSources = await evidence.findAllByProduct(productId);

      // Filter for accepted evidence only (Publication Rule 1, 2, 3)
      const acceptedItems = allEvidenceWithSources.filter(
        (item) => item.evidence.reviewStatus === 'accepted',
      );

      // Run conflict detection on active evidence (pending + accepted)
      const { detectedConflicts } = detectConflicts(productId, allEvidenceWithSources);

      // Determine if any active conflict involves an accepted commitment or claims of the same type
      const hasConflictOnAccepted = detectedConflicts.some((group) =>
        group.evidence.some((e) => e.reviewStatus === 'accepted'),
      );

      let status: PublicSupportInformation['status'];
      let supportStart: PublicDateCommitment | null = null;
      let supportEnd: PublicDateCommitment | null = null;
      let summaryStatement = '';

      if (acceptedItems.length === 0) {
        // Publication Rules 1, 2, 3: No accepted evidence -> Insufficient Information
        status = 'INSUFFICIENT_INFORMATION';
        summaryStatement =
          'Insufficient reviewed manufacturer security-support information is currently available for this product.';
      } else if (hasConflictOnAccepted) {
        // Publication Rules 4, 5, 6: Conflicts detected involving accepted commitments
        status = 'CONFLICTING_INFORMATION';
        summaryStatement =
          'Conflicting manufacturer support commitments have been identified across sources. Supporting statements reviewed by SS Tool.';
        // Rule 5: If conflicting support commitments exist, do NOT arbitrarily pick one
        supportEnd = null;
        supportStart = null;
      } else {
        // Publication Rule 1: Verified manufacturer commitments available without contradiction
        status = 'INFORMATION_AVAILABLE';

        // Extract accepted support_end commitment if present
        const acceptedEnd = acceptedItems.filter((item) => item.evidence.claimType === 'support_end');
        if (acceptedEnd.length > 0) {
          const firstEnd = acceptedEnd[0]!.evidence;
          const precision = firstEnd.datePrecision ?? 'day';
          supportEnd = {
            value: precision === 'day' ? firstEnd.normalizedDate : null,
            displayValue: firstEnd.dateText ?? firstEnd.normalizedDate ?? '',
            precision,
          };
        }

        // Extract accepted support_start commitment if present
        const acceptedStart = acceptedItems.filter(
          (item) => item.evidence.claimType === 'support_start',
        );
        if (acceptedStart.length > 0) {
          const firstStart = acceptedStart[0]!.evidence;
          const precision = firstStart.datePrecision ?? 'day';
          supportStart = {
            value: precision === 'day' ? firstStart.normalizedDate : null,
            displayValue: firstStart.dateText ?? firstStart.normalizedDate ?? '',
            precision,
          };
        }

        if (supportEnd) {
          summaryStatement = `Manufacturer-stated security-update support until ${supportEnd.displayValue}. Supporting statement reviewed by SS Tool.`;
        } else if (supportStart) {
          summaryStatement = `Manufacturer-stated security-update support starting ${supportStart.displayValue}. Supporting statement reviewed by SS Tool.`;
        } else {
          summaryStatement = 'Manufacturer-stated security support policies reviewed by SS Tool.';
        }
      }

      // Collect supported operating systems from accepted os_version claims
      const operatingSystems = Array.from(
        new Set(
          acceptedItems
            .filter((item) => item.evidence.claimType === 'os_version')
            .map((item) => item.evidence.rawText.trim())
            .filter(Boolean),
        ),
      );

      // Collect accepted policy statements
      const policyStatements = Array.from(
        new Set(
          acceptedItems
            .filter((item) => item.evidence.claimType === 'policy')
            .map((item) => item.evidence.rawText.trim())
            .filter(Boolean),
        ),
      );

      // Build sanitized public claims (ONLY accepted evidence, no internal notes/AI provider info)
      const claims: PublicClaimItem[] = acceptedItems.map((item) => ({
        id: item.evidence.id,
        claimType: item.evidence.claimType,
        statement: item.evidence.rawText,
        quotation: item.evidence.quotedExcerpt,
        dateText: item.evidence.dateText,
        datePrecision: item.evidence.datePrecision,
        normalizedDate: item.evidence.normalizedDate,
        source: item.source
          ? {
              url: item.source.url,
              domain: item.source.domain,
              title: item.source.title,
              lastRetrieved: item.source.fetchedAt?.toISOString() ?? null,
            }
          : null,
        reviewStatus: 'accepted' as const,
      }));

      // Deduplicate manufacturer sources backing accepted claims
      const sourcesMap = new Map<string, PublicSourceItem>();
      for (const item of acceptedItems) {
        if (item.source && !sourcesMap.has(item.source.url)) {
          sourcesMap.set(item.source.url, {
            url: item.source.url,
            domain: item.source.domain,
            title: item.source.title,
            lastRetrieved: item.source.fetchedAt?.toISOString() ?? null,
          });
        }
      }
      const sources = Array.from(sourcesMap.values());

      // Determine lastUpdated timestamp based on the latest review/update of accepted evidence
      let lastUpdated = product.updatedAt ? product.updatedAt.toISOString() : product.createdAt.toISOString();
      for (const item of acceptedItems) {
        const itemDate = item.evidence.updatedAt ?? item.evidence.createdAt;
        if (itemDate && itemDate.toISOString() > lastUpdated) {
          lastUpdated = itemDate.toISOString();
        }
      }

      const productDetails: PublicProductDetails = {
        id: product.id,
        name: product.name,
        manufacturer: {
          id: manufacturer.id,
          name: manufacturer.name,
          website: manufacturer.website,
          countryCode: manufacturer.countryCode,
        },
        modelIdentifier: product.modelIdentifier,
        gtin: product.gtin,
        category: product.category,
        productUrl: product.productUrl,
      };

      const responseData = {
        product: productDetails,
        supportInformation: {
          status,
          summaryStatement,
          disclaimer: PUBLIC_DISCLAIMER,
          supportStart,
          supportEnd,
          operatingSystems,
          policyStatements,
          claims,
          sources,
        },
        lastUpdated,
      };

      // Validate contract with Zod before returning
      const validated = publicSupportCardResponseSchema.parse({ data: responseData });
      return validated.data;
    },

    async lookupProduct(query: PublicProductLookupQuery) {
      const gtin = query.gtin?.trim() || undefined;
      const manufacturer = (query.manufacturer || query.manufacturerName)?.trim() || undefined;
      const model = (query.modelIdentifier || query.model)?.trim() || undefined;

      if (!gtin && !manufacturer && !model) {
        throw new AppError(
          400,
          'MISSING_LOOKUP_PARAMETERS',
          'At least one valid lookup method is required (gtin, or manufacturer and modelIdentifier)',
        );
      }

      if (!gtin && (Boolean(manufacturer) !== Boolean(model))) {
        throw new AppError(
          400,
          'INVALID_LOOKUP_PARAMETERS',
          'Both manufacturer and modelIdentifier must be provided for model lookup',
        );
      }

      let matches: ProductWithManufacturer[] = [];

      if (gtin) {
        if (!isValidGtin(gtin)) {
          throw new AppError(400, 'INVALID_GTIN', 'Invalid GTIN format or checksum');
        }
        matches = await products.findByGtin(gtin);
      } else if (manufacturer && model) {
        matches = await products.findByManufacturerNameAndModel(manufacturer, model);
      }

      if (matches.length === 0) {
        throw AppError.notFound('PRODUCT_NOT_FOUND', 'No product found matching the lookup criteria');
      }

      if (matches.length > 1) {
        throw AppError.conflict(
          'AMBIGUOUS_PRODUCT_MATCH',
          'Multiple products match the lookup criteria. More specific criteria are required.',
        );
      }

      const match = matches[0]!;
      const productDetails: PublicProductDetails = {
        id: match.product.id,
        name: match.product.name,
        manufacturer: {
          id: match.manufacturer.id,
          name: match.manufacturer.name,
          website: match.manufacturer.website,
          countryCode: match.manufacturer.countryCode,
        },
        modelIdentifier: match.product.modelIdentifier,
        gtin: match.product.gtin,
        category: match.product.category,
        productUrl: match.product.productUrl,
      };

      const responseData = {
        product: productDetails,
        supportCardUrl: `/api/v1/public/products/${match.product.id}/support-card`,
      };

      const validated = publicProductLookupResponseSchema.parse({ data: responseData });
      return validated.data;
    },
  };
}
