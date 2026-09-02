CREATE TYPE "public"."key_owner_type" AS ENUM('user', 'merchant', 'platform');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('customer', 'merchant', 'admin');--> statement-breakpoint
CREATE TYPE "public"."merchant_status" AS ENUM('active', 'paused', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."promotion_type" AS ENUM('percentage_off', 'flat_off', 'free_shipping');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."cart_status" AS ENUM('open', 'converted', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."checkout_session_state" AS ENUM('created', 'ready', 'requires_authorization', 'completed', 'canceled', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."order_state" AS ENUM('pending_payment', 'paid', 'fulfilled', 'canceled', 'refunded', 'payment_failed');--> statement-breakpoint
CREATE TYPE "public"."payment_state" AS ENUM('created', 'authorized', 'captured', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."agent_kind" AS ENUM('customer', 'merchant');--> statement-breakpoint
CREATE TYPE "public"."agent_session_state" AS ENUM('active', 'awaiting_approval', 'completed', 'failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."insight_kind" AS ENUM('restock', 'stockout_risk', 'overstock', 'price_adjustment', 'promotion', 'availability', 'demand_trend', 'catalog_quality');--> statement-breakpoint
CREATE TYPE "public"."insight_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."insight_status" AS ENUM('open', 'approved', 'executed', 'dismissed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."mandate_status" AS ENUM('active', 'consumed', 'expired', 'revoked', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."mandate_type" AS ENUM('intent', 'cart', 'payment');--> statement-breakpoint
CREATE TYPE "public"."policy_scope" AS ENUM('user', 'merchant', 'platform');--> statement-breakpoint
CREATE TABLE "accounts" (
	"user_id" varchar(36) NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signing_keys" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" "key_owner_type" NOT NULL,
	"owner_id" varchar(36) NOT NULL,
	"kid" varchar(64) NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"private_jwk" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signing_keys_kid_unique" UNIQUE("kid")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" text,
	"name" varchar(160) NOT NULL,
	"role" "user_role" DEFAULT 'customer' NOT NULL,
	"email_verified" timestamp with time zone,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "merchant_policies" (
	"merchant_id" varchar(36) PRIMARY KEY NOT NULL,
	"return_window_days" integer DEFAULT 7 NOT NULL,
	"returns_accepted" boolean DEFAULT true NOT NULL,
	"return_policy_text" text,
	"shipping_policy_text" text,
	"free_shipping_above_minor" integer,
	"flat_shipping_minor" integer DEFAULT 0 NOT NULL,
	"standard_delivery_days" integer DEFAULT 4 NOT NULL,
	"warranty_text" text,
	"cancellation_text" text,
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"slug" varchar(80) NOT NULL,
	"name" varchar(160) NOT NULL,
	"description" text,
	"logo_url" text,
	"support_email" varchar(255),
	"status" "merchant_status" DEFAULT 'active' NOT NULL,
	"fulfillment_rate_bp" integer DEFAULT 9500 NOT NULL,
	"avg_dispatch_hours" integer DEFAULT 24 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" varchar(36) NOT NULL,
	"code" varchar(40),
	"title" varchar(160) NOT NULL,
	"type" "promotion_type" NOT NULL,
	"value" integer NOT NULL,
	"conditions" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"active_from" timestamp with time zone,
	"active_to" timestamp with time zone,
	"created_by_agent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "availability_windows" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" varchar(36) NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "catalog_documents" (
	"product_id" varchar(36) PRIMARY KEY NOT NULL,
	"merchant_id" varchar(36) NOT NULL,
	"ai_text" text NOT NULL,
	"embedding" vector(384),
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', ai_text)) STORED,
	"source_hash" varchar(64) NOT NULL,
	"embedded_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory" (
	"variant_id" varchar(36) PRIMARY KEY NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"low_stock_threshold" integer DEFAULT 5 NOT NULL,
	"restock_eta" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" varchar(36) NOT NULL,
	"sku" varchar(80) NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"price_minor" integer NOT NULL,
	"compare_at_price_minor" integer,
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"barcode" varchar(64),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" varchar(36) NOT NULL,
	"title" varchar(240) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"brand" varchar(120),
	"category" varchar(120) NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"image_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "product_status" DEFAULT 'active' NOT NULL,
	"rating_bp" integer,
	"rating_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_id" varchar(36) NOT NULL,
	"variant_id" varchar(36) NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_minor" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"merchant_id" varchar(36) NOT NULL,
	"status" "cart_status" DEFAULT 'open' NOT NULL,
	"agent_session_id" varchar(36),
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkout_sessions" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_id" varchar(36) NOT NULL,
	"merchant_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"state" "checkout_session_state" DEFAULT 'created' NOT NULL,
	"totals" jsonb NOT NULL,
	"agent_identifier" varchar(160),
	"idempotency_key" varchar(120),
	"applied_promotion_id" varchar(36),
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"variant_id" varchar(36) NOT NULL,
	"title_snapshot" varchar(240) NOT NULL,
	"sku_snapshot" varchar(80) NOT NULL,
	"attributes_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_minor" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" varchar(32) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"merchant_id" varchar(36) NOT NULL,
	"checkout_session_id" varchar(36),
	"state" "order_state" DEFAULT 'pending_payment' NOT NULL,
	"totals" jsonb NOT NULL,
	"agent_session_id" varchar(36),
	"placed_by_agent" varchar(160),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_order_number_unique" UNIQUE("order_number")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" varchar(36) NOT NULL,
	"gateway" varchar(32) NOT NULL,
	"gateway_order_id" varchar(120),
	"gateway_payment_id" varchar(120),
	"amount_minor" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"state" "payment_state" DEFAULT 'created' NOT NULL,
	"payment_mandate_id" varchar(36),
	"idempotency_key" varchar(120) NOT NULL,
	"failure_reason" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" varchar(32) NOT NULL,
	"event_id" varchar(160),
	"event_type" varchar(120),
	"signature_valid" text,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_events" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"sequence" integer NOT NULL,
	"step" varchar(32) NOT NULL,
	"observation" jsonb NOT NULL,
	"reasoning" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"outcome" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_policies" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "policy_scope" NOT NULL,
	"scope_id" varchar(36),
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"merchant_id" varchar(36),
	"kind" "agent_kind" NOT NULL,
	"state" "agent_session_state" DEFAULT 'active' NOT NULL,
	"title" varchar(240),
	"current_step" varchar(32),
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" varchar(36),
	"user_id" varchar(36) NOT NULL,
	"merchant_id" varchar(36),
	"action" jsonb NOT NULL,
	"summary" text NOT NULL,
	"verdict" varchar(20) NOT NULL,
	"reason" text NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"decided_by" varchar(36),
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insights" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" varchar(36) NOT NULL,
	"session_id" varchar(36),
	"kind" "insight_kind" NOT NULL,
	"severity" "insight_severity" DEFAULT 'info' NOT NULL,
	"title" varchar(240) NOT NULL,
	"explanation" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"recommendation" jsonb NOT NULL,
	"projected_impact" jsonb,
	"status" "insight_status" DEFAULT 'open' NOT NULL,
	"approval_id" varchar(36),
	"executed_at" timestamp with time zone,
	"dismissed_reason" text,
	"auto_executable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mandates" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "mandate_type" NOT NULL,
	"parent_id" varchar(36),
	"user_id" varchar(36) NOT NULL,
	"merchant_id" varchar(36),
	"session_id" varchar(36),
	"payload" jsonb NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"signatures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "mandate_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_policies" ADD CONSTRAINT "merchant_policies_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_windows" ADD CONSTRAINT "availability_windows_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_documents" ADD CONSTRAINT "catalog_documents_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_documents" ADD CONSTRAINT "catalog_documents_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "availability_variant_idx" ON "availability_windows" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "catalog_search_idx" ON "catalog_documents" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "catalog_embedding_idx" ON "catalog_documents" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "variants_sku_idx" ON "product_variants" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "variants_product_idx" ON "product_variants" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "variants_price_idx" ON "product_variants" USING btree ("price_minor");--> statement-breakpoint
CREATE INDEX "products_merchant_idx" ON "products" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "cart_items_unique" ON "cart_items" USING btree ("cart_id","variant_id");--> statement-breakpoint
CREATE INDEX "carts_user_idx" ON "carts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_idempotency_idx" ON "checkout_sessions" USING btree ("merchant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_merchant_created_idx" ON "orders" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_user_idx" ON "orders" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idempotency_idx" ON "payments" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "agent_events_session_seq_idx" ON "agent_events" USING btree ("session_id","sequence");--> statement-breakpoint
CREATE INDEX "agent_sessions_user_idx" ON "agent_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "approvals_status_idx" ON "approvals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "insights_merchant_status_idx" ON "insights" USING btree ("merchant_id","status");--> statement-breakpoint
CREATE INDEX "mandates_user_idx" ON "mandates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mandates_parent_idx" ON "mandates" USING btree ("parent_id");