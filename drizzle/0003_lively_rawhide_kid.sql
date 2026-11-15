CREATE TABLE "evidence_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_id" uuid NOT NULL,
	"decision" "review_status" NOT NULL,
	"previous_status" "review_status" NOT NULL,
	"review_note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence_reviews" ADD CONSTRAINT "evidence_reviews_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "evidence_reviews_evidence_idx" ON "evidence_reviews" USING btree ("evidence_id");--> statement-breakpoint
CREATE INDEX "evidence_reviews_created_at_idx" ON "evidence_reviews" USING btree ("created_at");