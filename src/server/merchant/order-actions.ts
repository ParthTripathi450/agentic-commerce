"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { inventory, orderItems, orders } from "@/db/schema";
import { record, startSession } from "@/server/audit/recorder";
import { requireMerchant } from "@/lib/session";

/**
 * Merchant order operations.
 *
 * Fulfilment and cancellation are human decisions, not agent ones — the agent
 * has no tool for either. Both are audited so the order's history is complete
 * whether a person or an agent drove each step.
 */

type Result = { ok: true; message: string } | { error: string };

async function loadOwnedOrder(orderId: string, merchantId: string) {
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.merchantId, merchantId)))
    .limit(1);
  return order ?? null;
}

export async function fulfilOrderAction(orderId: string): Promise<Result> {
  const { user, merchant } = await requireMerchant();
  const order = await loadOwnedOrder(orderId, merchant.id);
  if (!order) return { error: "That order is not yours." };

  if (order.state !== "paid") {
    return {
      error:
        order.state === "fulfilled"
          ? "This order is already marked delivered."
          : `Only paid orders can be fulfilled — this one is ${order.state.replace(/_/g, " ")}.`,
    };
  }

  await db
    .update(orders)
    .set({ state: "fulfilled", updatedAt: new Date() })
    .where(eq(orders.id, order.id));

  await audit(order, user.id, "fulfil_order", `Marked ${order.orderNumber} delivered.`);
  revalidatePath("/merchant/orders");
  revalidatePath("/merchant");
  return { ok: true, message: `${order.orderNumber} marked delivered.` };
}

export async function cancelOrderAction(orderId: string, reason?: string): Promise<Result> {
  const { user, merchant } = await requireMerchant();
  const order = await loadOwnedOrder(orderId, merchant.id);
  if (!order) return { error: "That order is not yours." };

  if (order.state === "fulfilled") {
    return { error: "A delivered order cannot be cancelled — issue a refund instead." };
  }
  if (order.state === "canceled") return { error: "This order is already cancelled." };

  const wasPaid = order.state === "paid";

  await db
    .update(orders)
    .set({ state: "canceled", updatedAt: new Date() })
    .where(eq(orders.id, order.id));

  // Stock was decremented at payment; cancelling before dispatch returns it.
  if (wasPaid) {
    const lines = await db
      .select({ variantId: orderItems.variantId, quantity: orderItems.quantity })
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));

    for (const line of lines) {
      await db
        .update(inventory)
        .set({ quantity: sql`${inventory.quantity} + ${line.quantity}`, updatedAt: new Date() })
        .where(eq(inventory.variantId, line.variantId));
    }
  }

  await audit(
    order,
    user.id,
    "cancel_order",
    `Cancelled ${order.orderNumber}${wasPaid ? "; stock returned to inventory" : ""}.${reason ? ` Reason: ${reason}` : ""}`,
  );
  revalidatePath("/merchant/orders");
  revalidatePath("/merchant");
  return {
    ok: true,
    message: wasPaid
      ? `${order.orderNumber} cancelled and stock returned. Refund the customer in Razorpay.`
      : `${order.orderNumber} cancelled.`,
  };
}

async function audit(
  order: typeof orders.$inferSelect,
  userId: string,
  type: string,
  detail: string,
) {
  const sessionId =
    order.agentSessionId ??
    (
      await startSession({
        userId,
        kind: "merchant",
        merchantId: order.merchantId,
        title: `Order ${order.orderNumber}`,
      })
    ).id;

  await record(sessionId, {
    step: "EXECUTE",
    observation: { summary: detail, inputs: { orderNumber: order.orderNumber } },
    reasoning: { summary: "Merchant action, taken by a person rather than the agent." },
    action: { type, verdict: "ALLOW" },
    outcome: { status: "ok", detail },
  });
}
