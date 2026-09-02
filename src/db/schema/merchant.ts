import { relations } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { createdAt, currency, pk, updatedAt } from "./_shared";
import { users } from "./auth";

export const merchantStatus = pgEnum("merchant_status", ["active", "paused", "suspended"]);

export const merchants = pgTable("merchants", {
  id: pk(),
  userId: varchar("user_id", { length: 36 })
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  slug: varchar("slug", { length: 80 }).notNull().unique(),
  name: varchar("name", { length: 160 }).notNull(),
  description: text("description"),
  logoUrl: text("logo_url"),
  supportEmail: varchar("support_email", { length: 255 }),
  status: merchantStatus("status").notNull().default("active"),

  /** Rolling reliability signals used by the ranker (0..1). */
  fulfillmentRate: integer("fulfillment_rate_bp").notNull().default(9500),
  avgDispatchHours: integer("avg_dispatch_hours").notNull().default(24),

  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Merchant policies. Surfaced verbatim in the UCP capability manifest and the
 * ACP feed, and consumed by the ranker (return window and shipping speed are
 * scored criteria, not decoration).
 */
export const merchantPolicies = pgTable("merchant_policies", {
  merchantId: varchar("merchant_id", { length: 36 })
    .primaryKey()
    .references(() => merchants.id, { onDelete: "cascade" }),
  returnWindowDays: integer("return_window_days").notNull().default(7),
  returnsAccepted: boolean("returns_accepted").notNull().default(true),
  returnPolicyText: text("return_policy_text"),
  shippingPolicyText: text("shipping_policy_text"),
  freeShippingAboveMinor: integer("free_shipping_above_minor"),
  flatShippingMinor: integer("flat_shipping_minor").notNull().default(0),
  standardDeliveryDays: integer("standard_delivery_days").notNull().default(4),
  warrantyText: text("warranty_text"),
  cancellationText: text("cancellation_text"),
  currency: currency(),
  updatedAt: updatedAt(),
});

export const promotionType = pgEnum("promotion_type", [
  "percentage_off",
  "flat_off",
  "free_shipping",
]);

export const promotions = pgTable("promotions", {
  id: pk(),
  merchantId: varchar("merchant_id", { length: 36 })
    .notNull()
    .references(() => merchants.id, { onDelete: "cascade" }),
  code: varchar("code", { length: 40 }),
  title: varchar("title", { length: 160 }).notNull(),
  type: promotionType("type").notNull(),
  /** Percentage in basis points, or a flat amount in minor units. */
  value: integer("value").notNull(),
  conditions: jsonb("conditions").$type<{
    minSubtotalMinor?: number;
    productIds?: string[];
    categories?: string[];
  }>(),
  active: boolean("active").notNull().default(true),
  activeFrom: timestamp("active_from", { withTimezone: true }),
  activeTo: timestamp("active_to", { withTimezone: true }),
  /** Set when a promotion was created by the merchant agent rather than a human. */
  createdByAgent: boolean("created_by_agent").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const merchantsRelations = relations(merchants, ({ one, many }) => ({
  owner: one(users, { fields: [merchants.userId], references: [users.id] }),
  policies: one(merchantPolicies, {
    fields: [merchants.id],
    references: [merchantPolicies.merchantId],
  }),
  promotions: many(promotions),
}));
