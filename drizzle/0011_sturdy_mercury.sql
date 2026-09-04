DROP INDEX "recovery_one_open_order_idx";--> statement-breakpoint
DROP INDEX "recovery_one_open_cart_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_one_case_per_order_idx" ON "recovery_cases" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_one_case_per_cart_idx" ON "recovery_cases" USING btree ("cart_id");