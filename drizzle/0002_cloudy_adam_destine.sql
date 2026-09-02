CREATE TABLE "merchant_reviews" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"rating_bp" integer NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchant_reviews" ADD CONSTRAINT "merchant_reviews_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_reviews" ADD CONSTRAINT "merchant_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_reviews" ADD CONSTRAINT "merchant_reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_reviews_order_idx" ON "merchant_reviews" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "merchant_reviews_merchant_idx" ON "merchant_reviews" USING btree ("merchant_id");