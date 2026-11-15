import { createHash } from 'node:crypto';
import type { Database } from '../db/client.js';
import type { ReviewStatus } from '../db/schema.js';
import { dateTextSupportedByQuotation } from '../extraction/date-normalizer.js';
import { validateClaimSemantics } from '../extraction/claim-guards.js';
import { validateQuotation } from '../extraction/quotation-validator.js';
import { createEvidenceRepository } from '../repositories/evidence-repository.js';
import { createProductRepository } from '../repositories/product-repository.js';
import { createProductSourceRepository } from '../repositories/product-source-repository.js';
import { createSourceRepository } from '../repositories/source-repository.js';
import { createVerificationService } from '../verification/verification-service.js';
import {
  DEMO_DATASET_VERSION,
  DEMO_MANUFACTURER,
  DEMO_PRODUCTS,
  DEMO_SOURCE,
  DEMO_SOURCE_CAPTURE_DATE,
  DEMO_SOURCE_CONTENT,
} from './demo-dataset.js';

export interface DemoSeedEvidenceResult {
  productId: string;
  evidenceId: string;
  action: 'inserted-and-accepted' | 'already-accepted' | 'rejected-untouched';
}

export interface DemoSeedResult {
  demonstration: true;
  datasetVersion: string;
  manufacturerId: string;
  sourceId: string;
  productCount: number;
  evidence: DemoSeedEvidenceResult[];
  warnings: string[];
}

/**
 * Idempotently seeds the curated judge demo. It never truncates tables, never
 * overwrites real catalogue rows outside the fixed demo IDs, and never
 * re-accepts evidence that a reviewer has already rejected.
 */
export async function seedJudgeDemo(database: Database): Promise<DemoSeedResult> {
  const sourceRepository = createSourceRepository(database.orm);
  const productSourceRepository = createProductSourceRepository(database.orm);
  const verificationService = createVerificationService({
    products: createProductRepository(database.orm),
    evidence: createEvidenceRepository(database.orm),
    sources: sourceRepository,
    productSources: productSourceRepository,
  });

  const [existingManufacturer] = await database.client`
    select id from manufacturers where normalized_name = ${DEMO_MANUFACTURER.normalizedName} limit 1
  `;

  let manufacturerId: string;
  if (existingManufacturer?.id) {
    manufacturerId = String(existingManufacturer.id);
    await database.client`
      update manufacturers
      set name = ${DEMO_MANUFACTURER.name},
          website = ${DEMO_MANUFACTURER.website},
          country_code = ${DEMO_MANUFACTURER.countryCode},
          updated_at = now()
      where id = ${manufacturerId}
    `;
  } else {
    manufacturerId = DEMO_MANUFACTURER.id;
    await database.client`
      insert into manufacturers (id, name, normalized_name, website, country_code)
      values (
        ${manufacturerId},
        ${DEMO_MANUFACTURER.name},
        ${DEMO_MANUFACTURER.normalizedName},
        ${DEMO_MANUFACTURER.website},
        ${DEMO_MANUFACTURER.countryCode}
      )
      on conflict (id) do update
      set name = excluded.name,
          normalized_name = excluded.normalized_name,
          website = excluded.website,
          country_code = excluded.country_code,
          updated_at = now()
    `;
  }

  const source = await sourceRepository.upsert({
    id: DEMO_SOURCE.id,
    url: DEMO_SOURCE.url,
    domain: DEMO_SOURCE.domain,
    title: DEMO_SOURCE.title,
    description: null,
    contentType: 'text/html',
    contentText: DEMO_SOURCE_CONTENT,
    httpStatus: DEMO_SOURCE.httpStatus,
    contentHash: createHash('sha256').update(DEMO_SOURCE_CONTENT).digest('hex'),
    fetchedAt: DEMO_SOURCE.fetchedAt,
  });

  for (const product of DEMO_PRODUCTS) {
    await database.client`
      insert into products (
        id, manufacturer_id, name, model_identifier, category, product_url, market_region
      )
      values (
        ${product.id},
        ${manufacturerId},
        ${product.name},
        ${product.modelIdentifier},
        ${product.category},
        ${product.productUrl},
        ${product.marketRegion}
      )
      on conflict (id) do update
      set manufacturer_id = excluded.manufacturer_id,
          name = excluded.name,
          model_identifier = excluded.model_identifier,
          category = excluded.category,
          product_url = excluded.product_url,
          market_region = excluded.market_region,
          updated_at = now()
    `;

    await productSourceRepository.associate({
      productId: product.id,
      sourceId: source.id,
      relationshipType: DEMO_SOURCE.relationshipType,
    });
  }

  const evidence: DemoSeedEvidenceResult[] = [];
  const warnings: string[] = [];

  for (const product of DEMO_PRODUCTS) {
    for (const claim of product.claims) {
      // Refuse to seed anything that the existing deterministic guards would
      // not accept. This keeps the demo tied to real, verifiable quotations.
      const quotationIntegrity = validateQuotation(claim.quotedExcerpt, DEMO_SOURCE_CONTENT);
      if (!quotationIntegrity.matched) {
        throw new Error(
          `Demo quotation is not present in the captured source for ${product.name}: ${quotationIntegrity.reason ?? 'mismatch'}`,
        );
      }

      if (
        claim.dateText &&
        !dateTextSupportedByQuotation(claim.dateText, claim.quotedExcerpt)
      ) {
        throw new Error(
          `Demo date "${claim.dateText}" is not supported by the quotation for ${product.name}.`,
        );
      }

      const semanticRejection = validateClaimSemantics(
        claim.claimType,
        claim.quotedExcerpt,
        claim.dateText,
      );
      if (semanticRejection) {
        throw new Error(
          `Demo claim for ${product.name} failed the claim guard: ${semanticRejection.code}`,
        );
      }

      await database.client`
        insert into evidence (
          id, product_id, source_id, claim_type, raw_text, quoted_excerpt,
          date_text, date_precision, normalized_date, confidence, explanation,
          claim_fingerprint, extraction_method, review_status
        )
        values (
          ${claim.id},
          ${product.id},
          ${source.id},
          ${claim.claimType},
          ${claim.rawText},
          ${claim.quotedExcerpt},
          ${claim.dateText},
          ${claim.datePrecision},
          ${claim.normalizedDate},
          null,
          ${`Curated from the Fairphone support article captured ${DEMO_SOURCE_CAPTURE_DATE}.`},
          ${claim.claimFingerprint},
          'manual',
          'pending'
        )
        on conflict (id) do nothing
      `;

      const [stored] = await database.client`
        select id, review_status from evidence where id = ${claim.id} limit 1
      `;
      if (!stored?.id) {
        throw new Error(`Demo evidence ${claim.id} could not be read after insertion.`);
      }

      const reviewStatus = stored.review_status as ReviewStatus;
      if (reviewStatus === 'accepted') {
        evidence.push({
          productId: product.id,
          evidenceId: String(stored.id),
          action: 'already-accepted',
        });
        continue;
      }

      if (reviewStatus === 'rejected') {
        warnings.push(
          `${product.name}: existing evidence ${String(stored.id)} is rejected and was left untouched.`,
        );
        evidence.push({
          productId: product.id,
          evidenceId: String(stored.id),
          action: 'rejected-untouched',
        });
        continue;
      }

      await verificationService.reviewEvidence({
        evidenceId: String(stored.id),
        decision: 'accepted',
        reviewNote:
          'Judge demo seed: the verbatim quotation and its year precision were checked against the captured Fairphone support article.',
      });

      evidence.push({
        productId: product.id,
        evidenceId: String(stored.id),
        action: 'inserted-and-accepted',
      });
    }
  }

  return {
    demonstration: true,
    datasetVersion: DEMO_DATASET_VERSION,
    manufacturerId,
    sourceId: source.id,
    productCount: DEMO_PRODUCTS.length,
    evidence,
    warnings,
  };
}
