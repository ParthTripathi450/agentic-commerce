"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { merchantPolicies, orders, payments } from "@/db/schema";
import { requireCustomer } from "@/lib/session";
import { canOfferRefund, withinReturnWindow } from "./refund";
import { executeRefund } from "./refund-writer";

/**
 * A shopper asking for their money back.
 *
 * Deliberately not a "request" that a merchant then approves. This marketplace
 * publishes each seller's returns window as a fact shoppers rank on — the
 * ranker scores it, the product page states it — and a policy you have to ask
 * permission to use is not a policy, it is a suggestion. So a refund inside the
 * stated window is honoured immediately, and outside it is refused with the
 * number that decided it.
 *
 * The seller keeps the wider power: `refundOrderAction` can return an order at
 * any age, because a merchant choosing to refund a year-old purchase is their
 * business. This is the floor, not the ceiling.
 */
export async function requestRefundAction(
  orderId: string,
  reason?: string,
): Promise<{ ok: true; message: string } | { error: string }> {
  const user = await requireCustomer();

  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.userId, user.id)))
    .limit(1);
  if (!order) return { error: "That order is not yours." };

  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.orderId, order.id))
    .orderBy(desc(payments.createdAt))
    .limit(1);

  if (!canOfferRefund(order.state, payment?.state === "captured")) {
    return { error: "There is nothing to refund on this order yet." };
  }

  const [policy] = await db
    .select()
    .from(merchantPolicies)
    .where(eq(merchantPolicies.merchantId, order.merchantId))
    .limit(1);

  const window = withinReturnWindow({
    placedAt: order.createdAt,
    returnsAccepted: policy?.returnsAccepted ?? true,
    returnWindowDays: policy?.returnWindowDays ?? 7,
  });
  if (!window.ok) return { error: window.reason };

  const result = await executeRefund({
    orderId: order.id,
    actorUserId: user.id,
    actorLabel: "the customer",
    reason,
  });
  if (!result.ok) return { error: result.error };

  revalidatePath("/orders");
  revalidatePath("/merchant/orders");
  return { ok: true, message: result.message };
}
