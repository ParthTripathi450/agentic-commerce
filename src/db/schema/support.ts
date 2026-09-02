import { relations } from "drizzle-orm";
import { index, pgEnum, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { createdAt, pk, updatedAt } from "./_shared";
import { users } from "./auth";
import { merchants } from "./merchant";
import { orders } from "./commerce";

/**
 * Customer support.
 *
 * A shopper's question goes to the merchant who sold the item, not to a
 * platform helpdesk — in a marketplace the merchant is the only party who can
 * actually answer about stock, delivery or a return.
 */
export const supportStatus = pgEnum("support_status", [
  "open",
  "awaiting_customer",
  "answered",
  "resolved",
]);

export const supportTopic = pgEnum("support_topic", [
  "order",
  "delivery",
  "return",
  "product",
  "payment",
  "other",
]);

export const supportThreads = pgTable(
  "support_threads",
  {
    id: pk(),
    customerId: varchar("customer_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    merchantId: varchar("merchant_id", { length: 36 })
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    /** Optional: a question about a specific order carries its context. */
    orderId: varchar("order_id", { length: 36 }).references(() => orders.id, {
      onDelete: "set null",
    }),
    subject: varchar("subject", { length: 200 }).notNull(),
    topic: supportTopic("topic").notNull().default("other"),
    status: supportStatus("status").notNull().default("open"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("support_customer_idx").on(t.customerId, t.lastMessageAt),
    index("support_merchant_idx").on(t.merchantId, t.status),
  ],
);

export const supportSender = pgEnum("support_sender", ["customer", "merchant"]);

export const supportMessages = pgTable(
  "support_messages",
  {
    id: pk(),
    threadId: varchar("thread_id", { length: 36 })
      .notNull()
      .references(() => supportThreads.id, { onDelete: "cascade" }),
    senderRole: supportSender("sender_role").notNull(),
    senderId: varchar("sender_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("support_messages_thread_idx").on(t.threadId, t.createdAt)],
);

export const supportThreadsRelations = relations(supportThreads, ({ one, many }) => ({
  customer: one(users, { fields: [supportThreads.customerId], references: [users.id] }),
  merchant: one(merchants, { fields: [supportThreads.merchantId], references: [merchants.id] }),
  messages: many(supportMessages),
}));

export const supportMessagesRelations = relations(supportMessages, ({ one }) => ({
  thread: one(supportThreads, {
    fields: [supportMessages.threadId],
    references: [supportThreads.id],
  }),
}));
