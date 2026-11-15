import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const manufacturers = pgTable(
  'manufacturers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    website: text('website'),
    countryCode: text('country_code'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('manufacturers_normalized_name_unique').on(table.normalizedName),
    index('manufacturers_name_idx').on(table.name),
    check(
      'manufacturers_country_code_format',
      sql`${table.countryCode} is null or ${table.countryCode} ~ '^[A-Z]{2}$'`,
    ),
  ],
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    manufacturerId: uuid('manufacturer_id')
      .notNull()
      .references(() => manufacturers.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    name: text('name').notNull(),
    modelIdentifier: text('model_identifier'),
    // Stored as text so leading zeros survive; the API validates the checksum.
    gtin: text('gtin'),
    sku: text('sku'),
    category: text('category'),
    productUrl: text('product_url'),
    marketRegion: text('market_region'),
    ...timestamps,
  },
  (table) => [
    index('products_manufacturer_id_idx').on(table.manufacturerId),
    index('products_gtin_idx').on(table.gtin),
    // A model identifier only identifies a product within its manufacturer, and
    // only when one is present. Comparison is case-insensitive by design.
    uniqueIndex('products_manufacturer_model_unique')
      .on(table.manufacturerId, sql`lower(${table.modelIdentifier})`)
      .where(sql`${table.modelIdentifier} is not null`),
    check(
      'products_gtin_format',
      sql`${table.gtin} is null or ${table.gtin} ~ '^([0-9]{8}|[0-9]{12,14})$'`,
    ),
  ],
);

export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    url: text('url').notNull(),
    domain: text('domain').notNull(),
    title: text('title'),
    // Extracted metadata. Full HTML is deliberately not stored.
    description: text('description'),
    contentType: text('content_type'),
    contentText: text('content_text'),
    httpStatus: integer('http_status'),
    contentHash: text('content_hash'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('sources_url_unique').on(table.url),
    index('sources_domain_idx').on(table.domain),
    check(
      'sources_http_status_range',
      sql`${table.httpStatus} is null or (${table.httpStatus} >= 100 and ${table.httpStatus} <= 599)`,
    ),
  ],
);

export const claimTypeEnum = pgEnum('claim_type', [
  'support_start',
  'support_end',
  'os_version',
  'policy',
]);

export const extractionMethodEnum = pgEnum('extraction_method', ['manual', 'extraction', 'ai']);

export const reviewStatusEnum = pgEnum('review_status', ['pending', 'accepted', 'rejected']);

// How precisely a manufacturer stated a date. A month-only or year-only
// commitment must never be turned into an invented exact day.
export const datePrecisionEnum = pgEnum('date_precision', ['day', 'month', 'year']);

export const evidence = pgTable(
  'evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      // Evidence has no meaning without its product; deleting a product removes it.
      .references(() => products.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      // A source cited by evidence must not disappear silently.
      .references(() => sources.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    claimType: claimTypeEnum('claim_type').notNull(),
    rawText: text('raw_text').notNull(),
    // The date exactly as the manufacturer stated it (e.g. "December 2030").
    dateText: text('date_text'),
    datePrecision: datePrecisionEnum('date_precision'),
    // SQL DATE (not a timestamp) so an unknown time-of-day is never invented.
    // Only populated when a full, unambiguous calendar date was stated.
    normalizedDate: date('normalized_date', { mode: 'string' }),
    quotedExcerpt: text('quoted_excerpt').notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3, mode: 'number' }),
    explanation: text('explanation'),
    // Stable hash used to make repeated AI extraction idempotent. Null for
    // manual or non-AI rows, which are never deduplicated against.
    claimFingerprint: text('claim_fingerprint'),
    extractionMethod: extractionMethodEnum('extraction_method').notNull(),
    // New evidence always starts unreviewed. Nothing is accepted automatically.
    reviewStatus: reviewStatusEnum('review_status').notNull().default('pending'),
    ...timestamps,
  },
  (table) => [
    index('evidence_product_id_idx').on(table.productId),
    index('evidence_source_id_idx').on(table.sourceId),
    index('evidence_product_claim_idx').on(table.productId, table.claimType),
    uniqueIndex('evidence_claim_fingerprint_unique')
      .on(table.productId, table.claimType, table.claimFingerprint)
      .where(sql`${table.claimFingerprint} is not null`),
    check(
      'evidence_confidence_range',
      sql`${table.confidence} is null or (${table.confidence} >= 0 and ${table.confidence} <= 1)`,
    ),
  ],
);

export const sourceRelationshipTypeEnum = pgEnum('source_relationship_type', [
  'manufacturer_homepage',
  'product_page',
  'support_page',
  'security_advisory',
  'policy_page',
  'discovered_candidate',
]);

export const productSources = pgTable(
  'product_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    relationshipType: sourceRelationshipTypeEnum('relationship_type').notNull(),
    discoveredAt: timestamp('discovered_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('product_sources_unique').on(
      table.productId,
      table.sourceId,
      table.relationshipType,
    ),
    index('product_sources_product_idx').on(table.productId),
    index('product_sources_source_idx').on(table.sourceId),
  ],
);

export const evidenceReviews = pgTable(
  'evidence_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    evidenceId: uuid('evidence_id')
      .notNull()
      .references(() => evidence.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    decision: reviewStatusEnum('decision').notNull(),
    previousStatus: reviewStatusEnum('previous_status').notNull(),
    reviewNote: text('review_note').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('evidence_reviews_evidence_idx').on(table.evidenceId),
    index('evidence_reviews_created_at_idx').on(table.createdAt),
  ],
);

export type Manufacturer = typeof manufacturers.$inferSelect;
export type NewManufacturer = typeof manufacturers.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type Evidence = typeof evidence.$inferSelect;
export type NewEvidence = typeof evidence.$inferInsert;
export type ProductSource = typeof productSources.$inferSelect;
export type NewProductSource = typeof productSources.$inferInsert;
export type EvidenceReview = typeof evidenceReviews.$inferSelect;
export type NewEvidenceReview = typeof evidenceReviews.$inferInsert;
export type SourceRelationshipType = (typeof sourceRelationshipTypeEnum.enumValues)[number];
export type ClaimType = (typeof claimTypeEnum.enumValues)[number];
export type ExtractionMethod = (typeof extractionMethodEnum.enumValues)[number];
export type ReviewStatus = (typeof reviewStatusEnum.enumValues)[number];
export type DatePrecision = (typeof datePrecisionEnum.enumValues)[number];
