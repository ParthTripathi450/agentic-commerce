CREATE TABLE "addresses" (
	"id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"label" varchar(40) DEFAULT 'Home' NOT NULL,
	"recipient" varchar(120) NOT NULL,
	"phone" varchar(24),
	"line1" varchar(200) NOT NULL,
	"line2" varchar(200),
	"city" varchar(80) NOT NULL,
	"state" varchar(80) NOT NULL,
	"postcode" varchar(16) NOT NULL,
	"country" varchar(60) DEFAULT 'India' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "address" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_address" jsonb;--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "addresses_user_idx" ON "addresses" USING btree ("user_id","is_default");