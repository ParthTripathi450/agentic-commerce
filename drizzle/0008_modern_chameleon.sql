CREATE TYPE "public"."signal_kind" AS ENUM('search', 'view', 'filter');--> statement-breakpoint
CREATE TABLE "shopper_signals" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"kind" "signal_kind" NOT NULL,
	"product_id" varchar(36),
	"query" varchar(200),
	"category" varchar(120),
	"brand" varchar(120),
	"price_minor" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shopper_signals" ADD CONSTRAINT "shopper_signals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopper_signals" ADD CONSTRAINT "shopper_signals_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shopper_signals_user_idx" ON "shopper_signals" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "shopper_signals_product_idx" ON "shopper_signals" USING btree ("product_id");