CREATE TYPE "public"."claim_type" AS ENUM('support_start', 'support_end', 'os_version', 'policy');--> statement-breakpoint
CREATE TYPE "public"."extraction_method" AS ENUM('manual', 'extraction', 'ai');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"claim_type" "claim_type" NOT NULL,
	"raw_text" text NOT NULL,
	"normalized_date" date,
	"quoted_excerpt" text NOT NULL,
	"confidence" numeric(4, 3),
	"extraction_method" "extraction_method" NOT NULL,
	"review_status" "review_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_confidence_range" CHECK ("evidence"."confidence" is null or ("evidence"."confidence" >= 0 and "evidence"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "manufacturers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"website" text,
	"country_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manufacturers_country_code_format" CHECK ("manufacturers"."country_code" is null or "manufacturers"."country_code" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"manufacturer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"model_identifier" text,
	"gtin" text,
	"sku" text,
	"category" text,
	"product_url" text,
	"market_region" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_gtin_format" CHECK ("products"."gtin" is null or "products"."gtin" ~ '^([0-9]{8}|[0-9]{12,14})$')
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"domain" text NOT NULL,
	"title" text,
	"http_status" integer,
	"content_hash" text,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_http_status_range" CHECK ("sources"."http_status" is null or ("sources"."http_status" >= 100 and "sources"."http_status" <= 599))
);
--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_manufacturer_id_manufacturers_id_fk" FOREIGN KEY ("manufacturer_id") REFERENCES "public"."manufacturers"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "evidence_product_id_idx" ON "evidence" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "evidence_source_id_idx" ON "evidence" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "evidence_product_claim_idx" ON "evidence" USING btree ("product_id","claim_type");--> statement-breakpoint
CREATE UNIQUE INDEX "manufacturers_normalized_name_unique" ON "manufacturers" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "manufacturers_name_idx" ON "manufacturers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "products_manufacturer_id_idx" ON "products" USING btree ("manufacturer_id");--> statement-breakpoint
CREATE INDEX "products_gtin_idx" ON "products" USING btree ("gtin");--> statement-breakpoint
CREATE UNIQUE INDEX "products_manufacturer_model_unique" ON "products" USING btree ("manufacturer_id",lower("model_identifier")) WHERE "products"."model_identifier" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sources_url_unique" ON "sources" USING btree ("url");--> statement-breakpoint
CREATE INDEX "sources_domain_idx" ON "sources" USING btree ("domain");