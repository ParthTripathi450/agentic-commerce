import { relations } from "drizzle-orm";
import { index, integer, pgTable, text, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { createdAt, pk, updatedAt } from "./_shared";
import { users } from "./auth";
import { merchants } from "./merchant";
import { products, productVariants } from "./catalog";
import { orders } from "./commerce";

/**
 * Customer reviews.
 *
 * Every review is tied to an order line, so a rating can only come from someone
 * who actually bought the item. That is what makes ratings safe to weight
 * heavily in the ranker — an unverifiable rating would be an attack surface on
 * search results, not a signal.
 */
export const productReviews = pgTable(
  "product_reviews",
  {
    id: pk(),
    productId: varchar("product_id", { length: 36 })
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    variantId: varchar("variant_id", { length: 36 })
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    merchantId: varchar("merchant_id", { length: 36 })
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The order that entitles this review. */
    orderId: varchar("order_id", { length: 36 })
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** 1000–5000: whole and half stars, in the same basis as products.ratingBp. */
    ratingBp: integer("rating_bp").notNull(),
    title: varchar("title", { length: 160 }),
    body: text("body"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One review per purchased line, editable rather than duplicable.
    uniqueIndex("reviews_order_variant_idx").on(t.orderId, t.variantId),
    index("reviews_product_idx").on(t.productId),
    index("reviews_user_idx").on(t.userId),
  ],
);

export const productReviewsRelations = relations(productReviews, ({ one }) => ({
  product: one(products, { fields: [productReviews.productId], references: [products.id] }),
  user: one(users, { fields: [productReviews.userId], references: [users.id] }),
}));

/**
 * Merchant service reviews.
 *
 * Separate from product reviews because they answer a different question: the
 * product rating says whether the item was good, this says whether the merchant
 * handled the order well. One per order, so it is anchored to a real purchase.
 */
export const merchantReviews = pgTable(
  "merchant_reviews",
  {
    id: pk(),
    merchantId: varchar("merchant_id", { length: 36 })
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orderId: varchar("order_id", { length: 36 })
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** 1000–5000, same basis as product ratings. */
    ratingBp: integer("rating_bp").notNull(),
    comment: text("comment"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("merchant_reviews_order_idx").on(t.orderId),
    index("merchant_reviews_merchant_idx").on(t.merchantId),
  ],
);
