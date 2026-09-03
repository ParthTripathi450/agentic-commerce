import { index, integer, pgEnum, pgTable, varchar } from "drizzle-orm/pg-core";
import { createdAt, pk } from "./_shared";
import { products } from "./catalog";
import { users } from "./auth";

export const signalKind = pgEnum("signal_kind", ["search", "view", "filter"]);

/**
 * Weak interest signals — what the shopper LOOKED FOR, as opposed to what they
 * bought.
 *
 * Purchases, reviews, carts and refunds are already recorded by the commerce
 * tables and are far stronger evidence; the knowledge base reads those directly
 * and this table adds nothing to them. What was missing was the browsing half:
 * a search typed into the catalogue, a category filter ticked, a product opened
 * and not bought. None of that touches an order, so without a log it is simply
 * gone by the next request.
 *
 * Deliberately thin. It stores the shape of the interest (a query string, a
 * category, a product id) and never a session id, IP, referrer or user agent —
 * this exists to make the agent's suggestions better, and anything beyond that
 * would be surveillance the feature does not need. It is append-only, and
 * `deleteShopperSignals` empties it on request.
 */
export const shopperSignals = pgTable(
  "shopper_signals",
  {
    id: pk(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: signalKind("kind").notNull(),
    /** Set for `view`; the product actually opened. */
    productId: varchar("product_id", { length: 36 }).references(() => products.id, {
      onDelete: "cascade",
    }),
    /** Set for `search`; the raw phrase typed. */
    query: varchar("query", { length: 200 }),
    /** Set for `filter` and carried on `view`, so a category can be counted. */
    category: varchar("category", { length: 120 }),
    brand: varchar("brand", { length: 120 }),
    /**
     * The price actually being looked at, in minor units. A shopper's real
     * budget shows in what they OPEN far more honestly than in what they say,
     * and this is the only place that observation survives.
     */
    priceMinor: integer("price_minor"),
    createdAt: createdAt(),
  },
  (t) => [
    index("shopper_signals_user_idx").on(t.userId, t.createdAt),
    index("shopper_signals_product_idx").on(t.productId),
  ],
);
