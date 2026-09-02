CREATE TYPE "public"."support_sender" AS ENUM('customer', 'merchant');--> statement-breakpoint
CREATE TYPE "public"."support_status" AS ENUM('open', 'awaiting_customer', 'answered', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."support_topic" AS ENUM('order', 'delivery', 'return', 'product', 'payment', 'other');--> statement-breakpoint
CREATE TABLE "product_reviews" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" varchar(36) NOT NULL,
	"variant_id" varchar(36) NOT NULL,
	"merchant_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"rating_bp" integer NOT NULL,
	"title" varchar(160),
	"body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" varchar(36) NOT NULL,
	"sender_role" "support_sender" NOT NULL,
	"sender_id" varchar(36) NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_threads" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" varchar(36) NOT NULL,
	"merchant_id" varchar(36) NOT NULL,
	"order_id" varchar(36),
	"subject" varchar(200) NOT NULL,
	"topic" "support_topic" DEFAULT 'other' NOT NULL,
	"status" "support_status" DEFAULT 'open' NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_thread_id_support_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."support_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_order_variant_idx" ON "product_reviews" USING btree ("order_id","variant_id");--> statement-breakpoint
CREATE INDEX "reviews_product_idx" ON "product_reviews" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "reviews_user_idx" ON "product_reviews" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "support_messages_thread_idx" ON "support_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "support_customer_idx" ON "support_threads" USING btree ("customer_id","last_message_at");--> statement-breakpoint
CREATE INDEX "support_merchant_idx" ON "support_threads" USING btree ("merchant_id","status");