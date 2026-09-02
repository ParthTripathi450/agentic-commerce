"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  merchants,
  orders,
  supportMessages,
  supportThreads,
} from "@/db/schema";
import { requireUser } from "@/lib/session";

/**
 * Customer support, routed merchant-to-customer.
 *
 * A shopper's question goes to the merchant who actually sold the item rather
 * than to a platform inbox — in a marketplace only the merchant can answer
 * about their stock, their delivery or their return policy.
 */

const createSchema = z.object({
  merchantId: z.string().min(1),
  orderId: z.string().optional(),
  subject: z.string().min(4, "Give your question a short subject").max(200),
  topic: z.enum(["order", "delivery", "return", "product", "payment", "other"]),
  message: z.string().min(10, "Please describe the issue in a sentence or two").max(4000),
});

export async function createSupportThreadAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const parsed = createSchema.safeParse({
    merchantId: formData.get("merchantId"),
    orderId: formData.get("orderId") || undefined,
    subject: formData.get("subject"),
    topic: formData.get("topic"),
    message: formData.get("message"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  }

  const [merchant] = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(eq(merchants.id, parsed.data.merchantId))
    .limit(1);
  if (!merchant) return { error: "That merchant no longer exists." };

  // An order reference must belong to this shopper — it exposes order context
  // to the merchant, so it cannot be an arbitrary id from the client.
  let orderId: string | null = null;
  if (parsed.data.orderId) {
    const [order] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.id, parsed.data.orderId),
          eq(orders.userId, user.id),
          eq(orders.merchantId, merchant.id),
        ),
      )
      .limit(1);
    if (!order) return { error: "That order is not yours, or is not from this merchant." };
    orderId = order.id;
  }

  const [thread] = await db
    .insert(supportThreads)
    .values({
      customerId: user.id,
      merchantId: merchant.id,
      orderId,
      subject: parsed.data.subject,
      topic: parsed.data.topic,
      status: "open",
      lastMessageAt: new Date(),
    })
    .returning();

  await db.insert(supportMessages).values({
    threadId: thread.id,
    senderRole: "customer",
    senderId: user.id,
    body: parsed.data.message,
  });

  revalidatePath("/support");
  return { ok: true, message: "Sent. The merchant will reply here.", threadId: thread.id };
}

const replySchema = z.object({
  threadId: z.string().min(1),
  body: z.string().min(1, "Write a reply first").max(4000),
});

export async function replyToThreadAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const parsed = replySchema.safeParse({
    threadId: formData.get("threadId"),
    body: formData.get("body"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Write a reply first." };
  }

  const [thread] = await db
    .select({
      id: supportThreads.id,
      customerId: supportThreads.customerId,
      merchantId: supportThreads.merchantId,
      merchantOwner: merchants.userId,
    })
    .from(supportThreads)
    .innerJoin(merchants, eq(merchants.id, supportThreads.merchantId))
    .where(eq(supportThreads.id, parsed.data.threadId))
    .limit(1);

  if (!thread) return { error: "That conversation no longer exists." };

  // Only the two parties to the conversation may post in it.
  const isCustomer = thread.customerId === user.id;
  const isMerchant = thread.merchantOwner === user.id;
  if (!isCustomer && !isMerchant) return { error: "This conversation is not yours." };

  await db.insert(supportMessages).values({
    threadId: thread.id,
    senderRole: isMerchant ? "merchant" : "customer",
    senderId: user.id,
    body: parsed.data.body,
  });

  await db
    .update(supportThreads)
    .set({
      // Whoever replies hands the ball to the other side.
      status: isMerchant ? "answered" : "open",
      lastMessageAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(supportThreads.id, thread.id));

  revalidatePath("/support");
  revalidatePath("/merchant/support");
  return { ok: true, message: "Reply sent." };
}

export async function resolveThreadAction(threadId: string) {
  const user = await requireUser();
  const [thread] = await db
    .select({
      id: supportThreads.id,
      customerId: supportThreads.customerId,
      merchantOwner: merchants.userId,
    })
    .from(supportThreads)
    .innerJoin(merchants, eq(merchants.id, supportThreads.merchantId))
    .where(eq(supportThreads.id, threadId))
    .limit(1);

  if (!thread) return { error: "That conversation no longer exists." };
  if (thread.customerId !== user.id && thread.merchantOwner !== user.id) {
    return { error: "This conversation is not yours." };
  }

  await db
    .update(supportThreads)
    .set({ status: "resolved", updatedAt: new Date() })
    .where(eq(supportThreads.id, threadId));

  revalidatePath("/support");
  revalidatePath("/merchant/support");
  return { ok: true, message: "Marked resolved." };
}
