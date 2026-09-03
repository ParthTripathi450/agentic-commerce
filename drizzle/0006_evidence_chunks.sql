CREATE TYPE "public"."evidence_kind" AS ENUM('review', 'spec', 'policy');--> statement-breakpoint
CREATE TABLE "evidence_chunks" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" varchar(36) NOT NULL,
	"merchant_id" varchar(36) NOT NULL,
	"kind" "evidence_kind" DEFAULT 'review' NOT NULL,
	"source_id" varchar(36),
	"body" text NOT NULL,
	"rating_bp" integer,
	"embedding" vector(384),
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED,
	"source_hash" varchar(64) NOT NULL,
	"embedded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence_chunks" ADD CONSTRAINT "evidence_chunks_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_chunks" ADD CONSTRAINT "evidence_chunks_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_product_idx" ON "evidence_chunks" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "evidence_search_idx" ON "evidence_chunks" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "evidence_embedding_idx" ON "evidence_chunks" USING hnsw ("embedding" vector_cosine_ops);