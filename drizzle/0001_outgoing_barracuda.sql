CREATE TYPE "public"."source_relationship_type" AS ENUM('manufacturer_homepage', 'product_page', 'support_page', 'security_advisory', 'policy_page', 'discovered_candidate');--> statement-breakpoint
CREATE TABLE "product_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"relationship_type" "source_relationship_type" NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "content_type" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "content_text" text;--> statement-breakpoint
ALTER TABLE "product_sources" ADD CONSTRAINT "product_sources_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "product_sources" ADD CONSTRAINT "product_sources_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "product_sources_unique" ON "product_sources" USING btree ("product_id","source_id","relationship_type");--> statement-breakpoint
CREATE INDEX "product_sources_product_idx" ON "product_sources" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_sources_source_idx" ON "product_sources" USING btree ("source_id");