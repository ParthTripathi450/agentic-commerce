import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { merchants, orderItems, orders, payments, type Totals } from "@/db/schema";
import { formatMoney } from "@/lib/money";
import { record, startSession } from "@/server/audit/recorder";
import { evaluatePolicy } from "@/server/policy/engine";
import { loadCart, reserveStock } from "./cart";
import { paymentGateway } from "./gateway";
import { sessionCartId } from "./checkout";

/**
 * Paying an order whose payment failed.
 *
 * The gap this closes: a `payment_failed` order showed the shopper the bank's
 * reason and "you were not charged", and offered no way to try again. The
 * recovery agent then messaged them saying "you can finish it here" and linked
 * to that page — outreach making a promise the UI could not keep. It is also
 * the only route by which a failed-payment case can ever be VERIFIED recovered,
 * since `verifyOrderPaid` reads a captured payment **on the same order**.
 *
 * **A retry is a new authorisation, not a replay of the old one.** Time has
 * passed: the shopper's daily limit may now be spent, the merchant may have
 * gone inactive, the goods may have sold out. So the policy engine is asked
 * again, stock is checked again, and a fresh gateway order is created. Nothing
 * here re-charges anything — this system stores no credential (§6), so the
 * shopper still enters the card themselves in the hosted window.
 *
 * The original failed payment row is KEPT and a new one written beside it. The
 * failure is what the recovery agent diagnosed from and what the merchant sees
 * on the timeline; overwriting it to save a row would erase the reason this
 * order needed rescuing at all.
 */

export type RetryResult =
  | {
      status: "ready";
      orderId: string;
      orderNumber: string;
      gatewayOrderId: string;
      gatewayKeyId: string | null;
      gateway: string;
      amountMinor: number;
      currency: string;
    }
  /** It was already paid — reported honestly rather than charged twice. */
  | { status: "paid"; orderId: string; orderNumber: string }
  | { status: "blocked"; reason: string; issues: string[] }
  | { status: "failed"; reason: string };

/** States from which a shopper may try to pay again. */
const RETRYABLE = new Set(["pending_payment", "payment_failed"]);

export async function retryOrderPayment(input: {
  userId: string;
  orderId: string;
}): Promise<RetryResult> {
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, input.orderId), eq(orders.userId, input.userId)))
    .limit(1);
  if (!order) return { status: "failed", reason: "That order was not found." };

  // Idempotent, like `confirmPayment`: a shopper who paid in another tab, or
  // whose webhook landed first, must not be walked into a second charge.
  if (order.state === "paid" || order.state === "fulfilled") {
    return { status: "paid", orderId: order.id, orderNumber: order.orderNumber };
  }
  if (!RETRYABLE.has(order.state)) {
    return { status: "failed", reason: `This order is ${order.state.replace(/_/g, " ")} and cannot be paid.` };
  }

  const totals = order.totals as Totals;
  const amountMinor = totals.totalMinor;

  const [merchant] = await db
    .select({ id: merchants.id, name: merchants.name, status: merchants.status })
    .from(merchants)
    .where(eq(merchants.id, order.merchantId))
    .limit(1);
  if (!merchant || merchant.status !== "active") {
    return { status: "blocked", reason: "This seller is no longer trading.", issues: [] };
  }

  const sessionId =
    order.agentSessionId ??
    (await startSession({ userId: input.userId, kind: "customer", title: `Retry ${order.orderNumber}` })).id;

  /*
   * The limits are re-checked, not inherited.
   *
   * The first authorisation happened at some earlier point against that day's
   * remaining headroom. Approving this one on the strength of that check would
   * make an old failed payment a way to spend past today's limit.
   */
  const items = await db
    .select({ variantId: orderItems.variantId, quantity: orderItems.quantity, title: orderItems.titleSnapshot })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  const decision = await evaluatePolicy(
    {
      type: "checkout",
      merchantId: merchant.id,
      totalMinor: amountMinor,
      itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
    },
    { userId: input.userId, merchantId: merchant.id },
  );

  await record(sessionId, {
    step: "POLICY_CHECK",
    observation: {
      summary: `Re-checked ${formatMoney(amountMinor)} against spending limits before retrying ${order.orderNumber}.`,
    },
    reasoning: { summary: decision.reason },
    action: { type: "pay", verdict: decision.verdict, params: { orderId: order.id } },
    outcome: {
      status: decision.verdict === "DENY" ? "blocked" : "ok",
      detail: decision.violations.map((v) => v.message).join("; ") || decision.reason,
    },
  });

  if (decision.verdict === "DENY") {
    return {
      status: "blocked",
      reason: decision.reason,
      issues: decision.violations.map((v) => v.message),
    };
  }

  /*
   * Stock, handled the same way `confirmPayment` will.
   *
   * When the original basket still exists it is re-RESERVED, because confirm
   * commits from that cart and committing what was never held would decrement
   * inventory twice. When it does not — the basket was cleaned up, or the order
   * predates one — confirm commits nothing, so this reserves nothing either and
   * only refuses what is genuinely unbuyable. Reserving without a matching
   * commit is how stock goes permanently missing.
   */
  const cartId = order.checkoutSessionId ? await sessionCartId(order.checkoutSessionId) : "";
  const cart = cartId ? await loadCart(cartId) : null;

  if (cart?.lines.length) {
    const reserved = await reserveStock(cart.lines);
    if (!reserved.ok) return { status: "blocked", reason: reserved.failure!, issues: [] };
  } else if (items.length) {
    const short = (await db.execute(sql`
      SELECT oi.title_snapshot AS title
      FROM order_items oi
      JOIN inventory i ON i.variant_id = oi.variant_id
      WHERE oi.order_id = ${order.id}
        AND i.quantity - i.reserved < oi.quantity
      LIMIT 3
    `)) as unknown as { title: string }[];
    if (short.length) {
      return {
        status: "blocked",
        reason: `${short[0].title} is out of stock, so this order cannot be completed.`,
        issues: short.map((s) => `${s.title} is no longer available`),
      };
    }
  }

  const gateway = paymentGateway();
  let gatewayOrder;
  try {
    gatewayOrder = await gateway.createOrder({
      amountMinor,
      currency: totals.currency,
      receipt: order.orderNumber,
      notes: { orderId: order.id, retry: "true" },
    });
  } catch (cause) {
    return { status: "failed", reason: `Payment could not be started: ${(cause as Error).message}` };
  }

  // Beside the failure, never over it. `confirmPayment` takes the newest row.
  await db.insert(payments).values({
    orderId: order.id,
    gateway: gateway.name,
    gatewayOrderId: gatewayOrder.gatewayOrderId,
    amountMinor,
    currency: totals.currency,
    state: "created",
    // Distinct per attempt: reusing the original key would let the gateway
    // collapse this into the charge that already failed.
    idempotencyKey: `retry-${order.id}-${gatewayOrder.gatewayOrderId}`,
  });

  await db
    .update(orders)
    .set({ state: "pending_payment", updatedAt: new Date() })
    .where(eq(orders.id, order.id));

  await record(sessionId, {
    step: "PAY",
    observation: { summary: `Shopper asked to pay ${order.orderNumber} again.` },
    reasoning: { summary: "Limits and stock re-checked; a fresh gateway order was opened." },
    action: { type: "create_gateway_order", verdict: "ALLOW", params: { orderId: order.id } },
    outcome: { status: "ok", detail: `gateway order ${gatewayOrder.gatewayOrderId}` },
  });

  return {
    status: "ready",
    orderId: order.id,
    orderNumber: order.orderNumber,
    gatewayOrderId: gatewayOrder.gatewayOrderId,
    gatewayKeyId: gateway.publicKeyId(),
    gateway: gateway.name,
    amountMinor,
    currency: totals.currency,
  };
}

/** The most recent payment attempt, which is the one a confirmation belongs to. */
export async function latestPayment(orderId: string) {
  const [row] = await db
    .select()
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(desc(payments.createdAt))
    .limit(1);
  return row ?? null;
}
