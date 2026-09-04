import { boolean, index, pgTable, varchar } from "drizzle-orm/pg-core";
import { createdAt, pk, updatedAt } from "./_shared";
import { users } from "./auth";

/**
 * Where a shopper wants things delivered.
 *
 * Kept in its own table rather than on `users` because one person legitimately
 * has several — home, office, a parent's house — and a marketplace that assumes
 * one forces them to edit it every time they send something somewhere else.
 *
 * **Orders do not reference this table.** They carry a snapshot
 * (`orders.shippingAddress`), for the same reason `order_items` snapshots the
 * title and SKU: an order is a record of what actually happened, and it must
 * still say where it went after the shopper edits this row or deletes it. A
 * foreign key would let a delivered order silently change its own history.
 */
export const addresses = pgTable(
  "addresses",
  {
    id: pk(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "Home", "Office" — what the shopper calls it. */
    label: varchar("label", { length: 40 }).notNull().default("Home"),
    recipient: varchar("recipient", { length: 120 }).notNull(),
    phone: varchar("phone", { length: 24 }),
    line1: varchar("line1", { length: 200 }).notNull(),
    line2: varchar("line2", { length: 200 }),
    city: varchar("city", { length: 80 }).notNull(),
    state: varchar("state", { length: 80 }).notNull(),
    postcode: varchar("postcode", { length: 16 }).notNull(),
    country: varchar("country", { length: 60 }).notNull().default("India"),
    /**
     * The one offered first at checkout.
     *
     * Not enforced unique in the database: a partial unique index would make
     * "make this one default" a two-statement dance that can fail halfway and
     * leave a shopper with none. `setDefaultAddress` clears the others in the
     * same transaction instead.
     */
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("addresses_user_idx").on(t.userId, t.isDefault)],
);
