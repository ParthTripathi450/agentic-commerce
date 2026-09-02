-- Weighted full-text search over title, tags and body.
--
-- Order matters: the generated search_vector references title_text and
-- tags_text, so those columns must exist before it is recreated. Drizzle
-- emitted them in the opposite order, which fails.

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "search_tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_documents" ADD COLUMN IF NOT EXISTS "title_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_documents" ADD COLUMN IF NOT EXISTS "tags_text" text DEFAULT '' NOT NULL;--> statement-breakpoint

-- Dropping the column also drops catalog_search_idx, which is recreated below.
ALTER TABLE "catalog_documents" DROP COLUMN IF EXISTS "search_vector";--> statement-breakpoint

ALTER TABLE "catalog_documents" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(title_text, '')), 'A')
  || setweight(to_tsvector('english', coalesce(tags_text, '')), 'A')
  || setweight(to_tsvector('english', ai_text), 'B')
) STORED;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "catalog_search_idx" ON "catalog_documents" USING gin ("search_vector");
