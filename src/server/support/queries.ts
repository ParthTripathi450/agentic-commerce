import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { merchants, orders, supportMessages, supportThreads } from "@/db/schema";
import { requireMerchant, requireUser } from "@/lib/session";

/**
 * Support read queries.
 *
 * Kept out of the "use server" module deliberately: every export there becomes
 * a callable POST endpoint, and read helpers have no business being one.
 */

export type ThreadSummary = {
  id: string;
  subject: string;
  topic: string;
  status: string;
  lastMessageAt: string;
  counterparty: string;
  orderNumber: string | null;
  messageCount: number;
  lastMessage: string;
  lastSender: string;
};

async function loadThreads(where: ReturnType<typeof sql>): Promise<ThreadSummary[]> {
  const rows = (await db.execute<Record<string, string>>(sql`
    SELECT t.id, t.subject, t.topic, t.status, t.last_message_at,
           m.name AS merchant_name, u.name AS customer_name,
           o.order_number,
           (SELECT count(*) FROM support_messages sm WHERE sm.thread_id = t.id) AS message_count,
           (SELECT sm.body FROM support_messages sm WHERE sm.thread_id = t.id
             ORDER BY sm.created_at DESC LIMIT 1) AS last_message,
           (SELECT sm.sender_role FROM support_messages sm WHERE sm.thread_id = t.id
             ORDER BY sm.created_at DESC LIMIT 1) AS last_sender
    FROM support_threads t
    JOIN merchants m ON m.id = t.merchant_id
    JOIN users u ON u.id = t.customer_id
    LEFT JOIN orders o ON o.id = t.order_id
    WHERE ${where}
    ORDER BY t.last_message_at DESC
    LIMIT 50
  `)) as unknown as Record<string, string>[];

  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    topic: r.topic,
    status: r.status,
    lastMessageAt: new Date(r.last_message_at).toISOString(),
    counterparty: r.merchant_name,
    customerName: r.customer_name,
    orderNumber: r.order_number ?? null,
    messageCount: Number(r.message_count),
    lastMessage: r.last_message ?? "",
    lastSender: r.last_sender ?? "customer",
  })) as ThreadSummary[];
}

export async function getCustomerThreads() {
  const user = await requireUser();
  return loadThreads(sql`t.customer_id = ${user.id}`);
}

export async function getMerchantThreads() {
  const { merchant } = await requireMerchant();
  return loadThreads(sql`t.merchant_id = ${merchant.id}`);
}

export async function getThreadMessages(threadId: string) {
  const user = await requireUser();
  const [thread] = await db
    .select({
      id: supportThreads.id,
      subject: supportThreads.subject,
      status: supportThreads.status,
      customerId: supportThreads.customerId,
      merchantOwner: merchants.userId,
      merchantName: merchants.name,
    })
    .from(supportThreads)
    .innerJoin(merchants, eq(merchants.id, supportThreads.merchantId))
    .where(eq(supportThreads.id, threadId))
    .limit(1);

  if (!thread || (thread.customerId !== user.id && thread.merchantOwner !== user.id)) return null;

  const messages = await db
    .select()
    .from(supportMessages)
    .where(eq(supportMessages.threadId, threadId))
    .orderBy(supportMessages.createdAt);

  return { thread, messages };
}

/** Merchants this shopper has bought from, so a query has somewhere to go. */
export async function getContactableMerchants() {
  const user = await requireUser();
  const rows = await db
    .select({
      id: merchants.id,
      name: merchants.name,
      orderId: sql<string>`max(${orders.id})`,
      orderNumber: sql<string>`max(${orders.orderNumber})`,
    })
    .from(orders)
    .innerJoin(merchants, eq(merchants.id, orders.merchantId))
    .where(eq(orders.userId, user.id))
    .groupBy(merchants.id, merchants.name)
    .orderBy(desc(sql`max(${orders.createdAt})`));

  return rows;
}

/** Every order this shopper placed, for attaching context to a query. */
export async function getCustomerOrderOptions() {
  const user = await requireUser();
  return db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      merchantId: orders.merchantId,
      merchantName: merchants.name,
    })
    .from(orders)
    .innerJoin(merchants, eq(merchants.id, orders.merchantId))
    .where(eq(orders.userId, user.id))
    .orderBy(desc(orders.createdAt))
    .limit(30);
}

/**
 * Conversations waiting on the person reading the page.
 *
 * "Pending" is not one thing — it depends entirely on who is asking, and the
 * thread status already encodes whose turn it is because `replyToThreadAction`
 * hands the ball over on every reply. A merchant is owed the threads where the
 * customer spoke last (`open`); a customer is owed the ones where the merchant
 * did (`answered`) and any explicitly put back to them (`awaiting_customer`).
 * `resolved` is nobody's.
 *
 * Counted in SQL rather than by loading threads and filtering: the sidebar
 * renders on every page in the app, and this must cost one cheap count.
 */
export async function pendingThreadsForCustomer(userId: string): Promise<number> {
  // The states are written out rather than interpolated from an array: drizzle
  // expands a JS array into a parameter LIST, so `= ANY(${[...]})` reaches
  // Postgres as `ANY(($1, $2))` and raises "requires array on right side".
  const [row] = (await db.execute(sql`
    SELECT count(*) AS n FROM support_threads
    WHERE customer_id = ${userId} AND status IN ('answered', 'awaiting_customer')
  `)) as unknown as { n: string }[];
  return Number(row?.n ?? 0);
}

/** Takes the merchant OWNER's user id, which is what a session carries. */
export async function pendingThreadsForMerchant(ownerUserId: string): Promise<number> {
  const [row] = (await db.execute(sql`
    SELECT count(*) AS n FROM support_threads t
    JOIN merchants m ON m.id = t.merchant_id
    WHERE m.user_id = ${ownerUserId} AND t.status = 'open'
  `)) as unknown as { n: string }[];
  return Number(row?.n ?? 0);
}
