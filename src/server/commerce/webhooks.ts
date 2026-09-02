import { eq } from "drizzle-orm";
import { db } from "@/db";
import { checkoutSessions, orders, payments, webhookEvents } from "@/db/schema";
import { record, startSession } from "@/server/audit/recorder";
import { commitStock, loadCart, markCartConverted, releaseStock } from "./cart";
import { paymentGateway } from "./gateway";

/**
 * Razorpay webhook processing.
 *
 * The client callback is the happy path, but it runs in the shopper's browser —
 * if they close the tab after paying, the order would sit in `pending_payment`
 * forever while their money moved. Webhooks are the authoritative, out-of-band
 * confirmation that closes that hole.
 *
 * Every event is stored before processing, and processing is idempotent on the
 * gateway event id, because gateways retry.
 */

export type WebhookOutcome = {
  status: "processed" | "duplicate" | "ignored" | "invalid" | "error";
  detail: string;
  orderId?: string;
};

type RazorpayEvent = {
  event: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; status?: string; error_description?: string } };
    order?: { entity?: { id?: string } };
    /** Refund events carry the payment entity too, so the order lookup still works. */
    refund?: { entity?: { id?: string; amount?: number; status?: string } };
  };
};

export async function handleRazorpayWebhook(
  rawBody: string,
  signature: string | null,
  eventId: string | null,
): Promise<WebhookOutcome> {
  const gateway = paymentGateway();

  // Fail closed: an unverifiable webhook must never move an order.
  if (!signature || !gateway.verifyWebhookSignature(rawBody, signature)) {
    await db.insert(webhookEvents).values({
      source: "razorpay",
      eventId,
      payload: safeParse(rawBody),
      signatureValid: "false",
      error: "signature verification failed",
    });
    return { status: "invalid", detail: "Signature verification failed." };
  }

  const event = safeParse(rawBody) as RazorpayEvent;

  // Idempotency: gateways retry, and a retry must not re-commit stock.
  if (eventId) {
    const [seen] = await db
      .select({ id: webhookEvents.id, processedAt: webhookEvents.processedAt })
      .from(webhookEvents)
      .where(eq(webhookEvents.eventId, eventId))
      .limit(1);
    if (seen?.processedAt) {
      return { status: "duplicate", detail: "Event already processed." };
    }
  }

  const [stored] = await db
    .insert(webhookEvents)
    .values({
      source: "razorpay",
      eventId,
      eventType: event.event,
      payload: event as unknown as Record<string, unknown>,
      signatureValid: "true",
    })
    .returning();

  const entity = event.payload?.payment?.entity;
  const gatewayOrderId = entity?.order_id ?? event.payload?.order?.entity?.id;

  if (!gatewayOrderId) {
    await markProcessed(stored.id, "no gateway order id on event");
    return { status: "ignored", detail: `Event ${event.event} carries no order reference.` };
  }

  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.gatewayOrderId, gatewayOrderId))
    .limit(1);

  if (!payment) {
    await markProcessed(stored.id, "no matching payment");
    return { status: "ignored", detail: "No payment matches that gateway order." };
  }

  const [order] = await db.select().from(orders).where(eq(orders.id, payment.orderId)).limit(1);
  if (!order) {
    await markProcessed(stored.id, "no matching order");
    return { status: "ignored", detail: "No order matches that payment." };
  }

  const outcome = await applyEvent(event.event, order, payment, entity, event.payload?.refund?.entity);
  await markProcessed(stored.id, outcome.detail);
  return outcome;
}

async function applyEvent(
  eventType: string,
  order: typeof orders.$inferSelect,
  payment: typeof payments.$inferSelect,
  entity: { id?: string; error_description?: string } | undefined,
  refundEntity: { id?: string; amount?: number; status?: string } | undefined,
): Promise<WebhookOutcome> {
  const sessionId =
    order.agentSessionId ??
    (
      await startSession({
        userId: order.userId,
        kind: "customer",
        title: `Webhook for ${order.orderNumber}`,
      })
    ).id;

  const cartId = order.checkoutSessionId
    ? (
        await db
          .select({ cartId: checkoutSessions.cartId })
          .from(checkoutSessions)
          .where(eq(checkoutSessions.id, order.checkoutSessionId))
          .limit(1)
      )[0]?.cartId
    : undefined;
  const cart = cartId ? await loadCart(cartId).catch(() => null) : null;

  if (eventType === "payment.captured" || eventType === "order.paid") {
    // Already settled by the browser callback — nothing left to do.
    if (order.state === "paid" || order.state === "fulfilled") {
      return { status: "duplicate", detail: "Order was already paid.", orderId: order.id };
    }

    await db
      .update(payments)
      .set({
        state: "captured",
        gatewayPaymentId: entity?.id ?? payment.gatewayPaymentId,
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));
    await db.update(orders).set({ state: "paid", updatedAt: new Date() }).where(eq(orders.id, order.id));

    if (cart?.lines.length) {
      await commitStock(cart.lines);
      await markCartConverted(cart.cartId);
    }
    if (order.checkoutSessionId) {
      await db
        .update(checkoutSessions)
        .set({ state: "completed", updatedAt: new Date() })
        .where(eq(checkoutSessions.id, order.checkoutSessionId));
    }

    await record(sessionId, {
      step: "CONFIRM",
      observation: { summary: `Razorpay confirmed payment for ${order.orderNumber} out of band.` },
      reasoning: {
        summary: "Webhook settled an order the browser callback never completed.",
      },
      action: { type: "webhook_payment_captured", verdict: "ALLOW" },
      outcome: { status: "ok", detail: entity?.id ?? "" },
    });

    return { status: "processed", detail: "Order marked paid from webhook.", orderId: order.id };
  }

  if (eventType === "payment.failed") {
    if (order.state === "paid" || order.state === "fulfilled") {
      // A later success outranks an earlier failure; never un-pay an order.
      return { status: "ignored", detail: "Order already paid; ignoring failure event." };
    }

    await db
      .update(payments)
      .set({
        state: "failed",
        failureReason: entity?.error_description ?? "reported failed by gateway",
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));
    await db
      .update(orders)
      .set({ state: "payment_failed", updatedAt: new Date() })
      .where(eq(orders.id, order.id));

    if (cart?.lines.length) await releaseStock(cart.lines);

    await record(sessionId, {
      step: "PAY",
      observation: { summary: `Razorpay reported a failed payment for ${order.orderNumber}.` },
      reasoning: { summary: "Held stock released so the units return to sale." },
      action: { type: "webhook_payment_failed", verdict: "DENY" },
      outcome: { status: "error", detail: entity?.error_description ?? "payment failed" },
    });

    return { status: "processed", detail: "Order marked failed; stock released.", orderId: order.id };
  }

  if (eventType === "refund.processed" || eventType === "refund.created") {
    if (order.state === "refunded" && payment.state === "refunded") {
      return { status: "duplicate", detail: "Order was already refunded.", orderId: order.id };
    }

    await db
      .update(payments)
      .set({
        state: "refunded",
        raw: { ...(payment.raw ?? {}), refund: refundEntity ?? { id: null, viaWebhook: true } },
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));
    await db
      .update(orders)
      .set({ state: "refunded", updatedAt: new Date() })
      .where(eq(orders.id, order.id));

    // Deliberately does NOT touch stock. This event fires both for refunds
    // issued here (where `refundOrderAction` has already made the stock
    // decision) and for ones issued straight from the Razorpay dashboard,
    // and the webhook cannot tell them apart. Restocking here would double
    // the units in the first case; over-counting sells things that are not
    // on the shelf, while under-counting is fixable by hand.
    await record(sessionId, {
      step: "CONFIRM",
      observation: { summary: `Razorpay reported a refund for ${order.orderNumber}.` },
      reasoning: {
        summary: "Order and payment marked refunded. Stock left alone — the webhook cannot tell a dashboard refund from one issued here.",
      },
      action: { type: "webhook_refund_processed", verdict: "ALLOW" },
      outcome: { status: "ok", detail: refundEntity?.id ?? "" },
    });

    return { status: "processed", detail: "Order marked refunded from webhook.", orderId: order.id };
  }

  return { status: "ignored", detail: `Event ${eventType} needs no action.` };
}

async function markProcessed(id: string, detail: string) {
  await db
    .update(webhookEvents)
    .set({ processedAt: new Date(), error: detail.startsWith("no ") ? detail : null })
    .where(eq(webhookEvents.id, id));
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { unparseable: raw.slice(0, 500) };
  }
}
