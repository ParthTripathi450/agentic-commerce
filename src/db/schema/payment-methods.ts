import { boolean, index, integer, pgTable, varchar } from "drizzle-orm/pg-core";
import { createdAt, pk, updatedAt } from "./_shared";
import { users } from "./auth";

/**
 * A saved payment method for agent-completed purchases.
 *
 * SAFETY: this table holds NO payment credentials. There is no card number
 * column, no CVV, no token — only display metadata (brand, last four, expiry)
 * so the shopper can recognise which method the agent will use. The values are
 * fabricated test data generated server-side; the application never accepts a
 * card number from anyone.
 *
 * Charges against a saved method run through the mock gateway, which moves no
 * money. Real Razorpay test-mode card payments still go through their hosted
 * checkout widget, because charging a stored card server-side would require
 * genuine tokenisation this project deliberately does not implement.
 */
export const paymentMethods = pgTable(
  "payment_methods",
  {
    id: pk(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Display only: "visa", "mastercard", "upi". */
    brand: varchar("brand", { length: 32 }).notNull(),
    /** Display only. Fabricated — never derived from a real card. */
    last4: varchar("last4", { length: 4 }).notNull(),
    holderName: varchar("holder_name", { length: 120 }).notNull(),
    expiryMonth: integer("expiry_month").notNull(),
    expiryYear: integer("expiry_year").notNull(),
    /** Which gateway can charge it. Only "mock" is ever written. */
    gateway: varchar("gateway", { length: 32 }).notNull().default("mock"),
    isDefault: boolean("is_default").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("payment_methods_user_idx").on(t.userId)],
);
