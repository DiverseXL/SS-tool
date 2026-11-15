CREATE TYPE "public"."date_precision" AS ENUM('day', 'month', 'year');--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "date_text" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "date_precision" date_precision;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "explanation" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "claim_fingerprint" text;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_claim_fingerprint_unique" ON "evidence" USING btree ("product_id","claim_type","claim_fingerprint") WHERE "evidence"."claim_fingerprint" is not null;