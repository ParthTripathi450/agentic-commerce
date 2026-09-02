import { relations } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { createdAt, currency, pk, updatedAt } from "./_shared";
import { users } from "./auth";
import { merchants } from "./merchant";
import { productVariants } from "./catalog";

export const cartStatus = pgEnum("cart_status", ["open", "converted", "abandoned"]);

export const carts = pgTable(
  "carts",
  {
    id: pk(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Single-merchant carts: checkout and fulfilment are per merchant. */
    merchantId: varchar("merchant_id", { length: 36 })
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    status: cartStatus("status").notNull().default("open"),
    /** The agent session that assembled this cart, when agent-created. */
    agentSessionId: varchar("agent_session_id", { length: 36 }),
    currency: currency(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("carts_user_idx").on(t.userId)],
);

export const cartItems = pgTable(
  "cart_items",
  {
    id: pk(),
    cartId: varchar("cart_id", { length: 36 })
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    variantId: varchar("variant_id", { length: 36 })
      .notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull().default(1),
    /** Price captured at add time; re-verified before any Cart Mandate is signed. */
    unitPriceMinor: integer("unit_price_minor").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("cart_items_unique").on(t.cartId, t.variantId)],
);

/**
 * UCP checkout session. States follow the UCP checkout capability:
 * created → ready (totals computed) → completed | canceled | expired.
 */
export const checkoutSessionState = pgEnum("checkout_session_state", [
  "created",
  "ready",
  "requires_authorization",
  "completed",
  "canceled",
  "expired",
  "failed",
]);

export type Totals = {
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  currency: string;
};

export const checkoutSessions = pgTable(
  "checkout_sessions",
  {
    id: pk(),
    cartId: varchar("cart_id", { length: 36 })
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    merchantId: varchar("merchant_id", { length: 36 })
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    state: checkoutSessionState("state").notNull().default("created"),
    totals: jsonb("totals").$type<Totals>().notNull(),
    /** Identifies the calling agent, from the UCP-Agent request header. */
    agentIdentifier: varchar("agent_identifier", { length: 160 }),
    idempotencyKey: varchar("idempotency_key", { length: 120 }),
    appliedPromotionId: varchar("applied_promotion_id", { length: 36 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("checkout_idempotency_idx").on(t.merchantId, t.idempotencyKey)],
);

export const orderState = pgEnum("order_state", [
  "pending_payment",
  "paid",
  "fulfilled",
  "canceled",
  "refunded",
  "payment_failed",
]);

export const orders = pgTable(
  "orders",
  {
    id: pk(),
    orderNumber: varchar("order_number", { length: 32 }).notNull().unique(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    merchantId: varchar("merchant_id", { length: 36 })
      .notNull()
      .references(() => merchants.id, { onDelete: "restrict" }),
    checkoutSessionId: varchar("checkout_session_id", { length: 36 }),
    state: orderState("state").notNull().default("pending_payment"),
    totals: jsonb("totals").$type<Totals>().notNull(),
    /** Non-null when an AI agent placed this order — powers agent-vs-human analytics. */
    agentSessionId: varchar("agent_session_id", { length: 36 }),
    placedByAgent: varchar("placed_by_agent", { length: 160 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("orders_merchant_created_idx").on(t.merchantId, t.createdAt),
    index("orders_user_idx").on(t.userId),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: pk(),
    orderId: varchar("order_id", { length: 36 })
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    variantId: varchar("variant_id", { length: 36 })
      .notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    /** Denormalised so historic orders survive catalog edits and deletions. */
    titleSnapshot: varchar("title_snapshot", { length: 240 }).notNull(),
    skuSnapshot: varchar("sku_snapshot", { length: 80 }).notNull(),
    attributesSnapshot: jsonb("attributes_snapshot")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    quantity: integer("quantity").notNull(),
    unitPriceMinor: integer("unit_price_minor").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("order_items_order_idx").on(t.orderId)],
);

export const paymentState = pgEnum("payment_state", [
  "created",
  "authorized",
  "captured",
  "failed",
  "refunded",
]);

export const payments = pgTable(
  "payments",
  {
    id: pk(),
    orderId: varchar("order_id", { length: 36 })
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    gateway: varchar("gateway", { length: 32 }).notNull(),
    gatewayOrderId: varchar("gateway_order_id", { length: 120 }),
    gatewayPaymentId: varchar("gateway_payment_id", { length: 120 }),
    amountMinor: integer("amount_minor").notNull(),
    currency: currency(),
    state: paymentState("state").notNull().default("created"),
    /** The PaymentMandate that authorised this charge. */
    paymentMandateId: varchar("payment_mandate_id", { length: 36 }),
    /** Reused verbatim on retry so a failed charge is never double-submitted. */
    idempotencyKey: varchar("idempotency_key", { length: 120 }).notNull(),
    failureReason: text("failure_reason"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("payments_idempotency_idx").on(t.idempotencyKey),
    index("payments_order_idx").on(t.orderId),
  ],
);

export const webhookEvents = pgTable("webhook_events", {
  id: pk(),
  source: varchar("source", { length: 32 }).notNull(),
  eventId: varchar("event_id", { length: 160 }),
  eventType: varchar("event_type", { length: 120 }),
  signatureValid: text("signature_valid"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  error: text("error"),
  createdAt: createdAt(),
});

export const cartsRelations = relations(carts, ({ many, one }) => ({
  items: many(cartItems),
  merchant: one(merchants, { fields: [carts.merchantId], references: [merchants.id] }),
}));

export const ordersRelations = relations(orders, ({ many, one }) => ({
  items: many(orderItems),
  merchant: one(merchants, { fields: [orders.merchantId], references: [merchants.id] }),
  payments: many(payments),
}));
