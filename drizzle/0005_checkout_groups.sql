CREATE TYPE "public"."checkout_group_state" AS ENUM('open', 'authorized', 'paid', 'failed', 'canceled');--> statement-breakpoint
CREATE TABLE "checkout_groups" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"state" "checkout_group_state" DEFAULT 'open' NOT NULL,
	"totals" jsonb NOT NULL,
	"gateway_order_id" varchar(120),
	"merchant_count" integer DEFAULT 0 NOT NULL,
	"agent_session_id" varchar(36),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "checkout_group_id" varchar(36);--> statement-breakpoint
ALTER TABLE "checkout_groups" ADD CONSTRAINT "checkout_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkout_groups_user_idx" ON "checkout_groups" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "orders_checkout_group_idx" ON "orders" USING btree ("checkout_group_id");