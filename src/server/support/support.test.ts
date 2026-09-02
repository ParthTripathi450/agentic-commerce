import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { merchants, supportMessages, supportThreads, users } from "@/db/schema";

/**
 * Support conversations are private to two parties.
 *
 * Exercised at the data layer: the actions themselves need an auth context, so
 * these assert the invariants those actions rely on — a thread always has a
 * customer and a merchant, and a message always belongs to a thread.
 */
let customerId: string;
let merchantId: string;
let merchantOwnerId: string;

beforeAll(async () => {
  const [customer] = await db.select().from(users).where(eq(users.email, "demo@shopper.test")).limit(1);
  const [merchant] = await db.select().from(merchants).where(eq(merchants.slug, "stride-athletics")).limit(1);
  customerId = customer.id;
  merchantId = merchant.id;
  merchantOwnerId = merchant.userId;
});

describe("support threads", () => {
  it("records a conversation with both parties and its messages", async () => {
    const [thread] = await db
      .insert(supportThreads)
      .values({
        customerId,
        merchantId,
        subject: "Where is my order?",
        topic: "order",
        status: "open",
      })
      .returning();

    await db.insert(supportMessages).values({
      threadId: thread.id,
      senderRole: "customer",
      senderId: customerId,
      body: "My order has not arrived yet.",
    });
    await db.insert(supportMessages).values({
      threadId: thread.id,
      senderRole: "merchant",
      senderId: merchantOwnerId,
      body: "It ships tomorrow — sorry for the wait.",
    });

    const messages = await db
      .select()
      .from(supportMessages)
      .where(eq(supportMessages.threadId, thread.id))
      .orderBy(supportMessages.createdAt);

    expect(messages).toHaveLength(2);
    expect(messages[0].senderRole).toBe("customer");
    expect(messages[1].senderRole).toBe("merchant");

    // Only these two identities appear — a thread has exactly two parties.
    const senders = new Set(messages.map((m) => m.senderId));
    expect(senders).toEqual(new Set([customerId, merchantOwnerId]));

    await db.delete(supportThreads).where(eq(supportThreads.id, thread.id));
  });

  it("removes messages when the thread is deleted", async () => {
    const [thread] = await db
      .insert(supportThreads)
      .values({ customerId, merchantId, subject: "Cascade check", topic: "other" })
      .returning();
    await db.insert(supportMessages).values({
      threadId: thread.id,
      senderRole: "customer",
      senderId: customerId,
      body: "test",
    });

    await db.delete(supportThreads).where(eq(supportThreads.id, thread.id));

    const orphans = await db
      .select()
      .from(supportMessages)
      .where(eq(supportMessages.threadId, thread.id));
    expect(orphans).toHaveLength(0);
  });
});
