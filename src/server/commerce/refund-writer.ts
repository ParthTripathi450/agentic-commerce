import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { inventory, orderItems, orders, payments } from "@/db/schema";
import { record, startSession } from "@/server/audit/recorder";
import { formatMoney } from "@/lib/money";
import { gatewayByName } from "./gateway";
import { evaluateRefund } from "./refund";

/**
 * The one place a refund is actually executed.
 *
 * A refund moves real money, restocks real inventory and writes an audit
 * record, and there are now two ways to start one — a merchant returning an
 * order, and a shopper asking for their money back. Two code paths doing that
 * would be two chances to get the gateway wrong, and §gateway records what
 * that costs: refunds resolve the gateway from `payments.gateway` because a
 * saved-method purchase settles on MockGateway even while
 * `PAYMENT_GATEWAY=razorpay`, and a second implementation is exactly where that
 * detail gets forgotten.
 *
 * So both callers do their own authorisation and policy checks — which differ,
 * and should — then hand the decision here. This function trusts that the
 * caller established the right to refund, and owns everything after it.
 */
export type RefundOutcome = { ok: true; message: string } | { ok: false; error: string };

export async function executeRefund(input: {
  orderId: string;
  /** Who is accountable for this refund, for the audit trail. */
  actorUserId: string;
  /** "the seller" or "the customer" — appears verbatim in the audit note. */
  actorLabel: string;
  reason?: string;
}): Promise<RefundOutcome> {
  const [order] = await db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
  if (!order) return { ok: false, error: "That order no longer exists." };

  // Most recent first: a retried charge leaves earlier failed rows behind.
  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.orderId, order.id))
    .orderBy(desc(payments.createdAt))
    .limit(1);

  const eligibility = evaluateRefund({
    orderState: order.state,
    paymentState: payment?.state ?? null,
    paymentAmountMinor: payment?.amountMinor ?? null,
    gatewayPaymentId: payment?.gatewayPaymentId ?? null,
  });
  if (!eligibility.ok) return { ok: false, error: eligibility.error };

  const { amountMinor, gatewayPaymentId, restock, stockNote } = eligibility.plan;

  // On the rails the charge came in on, never the configured default (§8.15).
  const gateway = gatewayByName(payment.gateway);
  let refund;
  try {
    refund = await gateway.refundPayment({
      gatewayPaymentId,
      amountMinor,
      notes: { order: order.orderNumber, requestedBy: input.actorLabel },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "gateway rejected the refund";
    await audit(order, input.actorUserId, `Refund of ${order.orderNumber} failed: ${detail}`);
    return { ok: false, error: `The gateway refused the refund: ${detail}` };
  }

  if (refund.status === "failed") {
    await audit(
      order,
      input.actorUserId,
      `Gateway reported the refund of ${order.orderNumber} as failed.`,
    );
    return { ok: false, error: "The gateway reported the refund as failed. Nothing was returned." };
  }

  await db
    .update(payments)
    .set({
      state: "refunded",
      raw: { ...(payment.raw ?? {}), refund: refund.raw },
      updatedAt: new Date(),
    })
    .where(eq(payments.id, payment.id));

  await db
    .update(orders)
    .set({ state: "refunded", updatedAt: new Date() })
    .where(eq(orders.id, order.id));

  if (restock) {
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

  const settled = refund.status === "pending" ? "is on its way back" : "returned";
  const detail =
    `${formatMoney(amountMinor, payment.currency)} ${settled} for ${order.orderNumber} ` +
    `via ${payment.gateway} (${refund.gatewayRefundId}); ${stockNote}. ` +
    `Requested by ${input.actorLabel}.` +
    (input.reason ? ` Reason: ${input.reason}` : "");

  await audit(order, input.actorUserId, detail);
  return { ok: true, message: detail };
}

async function audit(
  order: typeof orders.$inferSelect,
  userId: string,
  detail: string,
): Promise<void> {
  // Reuses the order's own agent session when it has one, so a refund lands in
  // the same audited thread as the purchase it reverses.
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
    reasoning: { summary: "Refund, requested by a person rather than the agent." },
    action: { type: "refund_order", verdict: "ALLOW" },
    outcome: { status: "ok", detail },
  });
}
