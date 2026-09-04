CREATE TYPE "public"."recovery_diagnosis" AS ENUM('likely_temporary', 'customer_action_required', 'repeated_failure', 'abandoned_before_payment', 'abandoned_at_payment', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."recovery_scenario" AS ENUM('failed_payment', 'abandoned_checkout', 'payment_degradation', 'failed_subscription', 'overdue_invoice');--> statement-breakpoint
CREATE TYPE "public"."recovery_state" AS ENUM('detected', 'diagnosed', 'awaiting_approval', 'acting', 'verifying', 'recovered', 'stopped', 'escalated', 'expired');--> statement-breakpoint
CREATE TABLE "recovery_cases" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"scenario" "recovery_scenario" NOT NULL,
	"state" "recovery_state" DEFAULT 'detected' NOT NULL,
	"order_id" varchar(36),
	"cart_id" varchar(36),
	"payment_id" varchar(36),
	"amount_at_risk_minor" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"diagnosis" "recovery_diagnosis",
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"incentive_minor" integer DEFAULT 0 NOT NULL,
	"next_action_at" timestamp with time zone,
	"recovered_minor" integer DEFAULT 0 NOT NULL,
	"recovered_at" timestamp with time zone,
	"stop_reason" text,
	"approval_id" varchar(36),
	"session_id" varchar(36),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recovery_merchant_idx" ON "recovery_cases" USING btree ("merchant_id","state");--> statement-breakpoint
CREATE INDEX "recovery_next_action_idx" ON "recovery_cases" USING btree ("next_action_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_one_open_order_idx" ON "recovery_cases" USING btree ("order_id") WHERE state NOT IN ('recovered','stopped','escalated','expired');--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_one_open_cart_idx" ON "recovery_cases" USING btree ("cart_id") WHERE state NOT IN ('recovered','stopped','escalated','expired');