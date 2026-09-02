import { createHmac, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { inventory, merchants, orders, payments, productVariants, products } from "@/db/schema";
import { addToCart } from "./cart";
import { authorizeCheckout, prepareCheckout } from "./checkout";
import { resetGatewayCache } from "./gateway";
import { emptyOpenCarts, ensureStock, provisionTestShopper } from "./test-utils";
import { handleRazorpayWebhook } from "./webhooks";

let userId: string;
let variantId: string;

/** The mock gateway signs webhooks with this, standing in for Razorpay's secret. */
const SECRET = "mock-gateway-secret";

/**
 * Event ids are unique per run, as a real gateway's are.
 *
 * Processed ids persist in webhook_events by design — that IS the idempotency
 * mechanism — so fixed ids would make every run after the first see duplicates.
 * The duplicate test below deliberately reuses one id within a single run.
 */
const RUN = randomUUID().slice(0, 8);
const evt = (name: string) => `evt_${RUN}_${name}`;
const sign = (body: string) => createHmac("sha256", SECRET).update(body).digest("hex");

async function available(id: string) {
  const [row] = await db
    .select({ available: sql<number>`${inventory.quantity} - ${inventory.reserved}` })
    .from(inventory)
    .where(eq(inventory.variantId, id));
  return Number(row.available);
}

/** Drives a checkout to the point where a gateway order exists but is unpaid. */
async function pendingOrder() {
  await emptyOpenCarts(userId);
  const cart = await addToCart({ userId, variantId, quantity: 1 });
  const proposal = await prepareCheckout({ userId, cartId: cart.id, intentText: "webhook test" });
  if (proposal.status !== "requires_authorization") throw new Error("expected proposal");
  const authorized = await authorizeCheckout({
    userId,
    approvalId: proposal.approvalId,
    decision: "approve",
  });
  if (authorized.status !== "authorized") throw new Error("expected authorization");
  return authorized;
}

function event(type: string, gatewayOrderId: string, paymentId = "pay_webhook_1") {
  return JSON.stringify({
    event: type,
    payload: {
      payment: {
        entity: { id: paymentId, order_id: gatewayOrderId, status: "captured", error_description: "card declined" },
      },
    },
  });
}

beforeAll(async () => {
  process.env.PAYMENT_GATEWAY = "mock";
  resetGatewayCache();
  userId = await provisionTestShopper("webhook-test@acp.test", "Webhook Test");

  const [merchant] = await db.select().from(merchants).where(eq(merchants.slug, "voltix-electronics")).limit(1);
  const [variant] = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(eq(products.merchantId, merchant.id), sql`${products.title} LIKE 'Pulse Buds%'`))
    .limit(1);
  variantId = variant.id;
  await ensureStock(variantId, 60);
});

describe("razorpay webhooks", () => {
  it("refuses an unsigned or forged webhook without touching the order", async () => {
    const authorized = await pendingOrder();
    const body = event("payment.captured", authorized.gatewayOrderId);

    const unsigned = await handleRazorpayWebhook(body, null, evt("unsigned"));
    const forged = await handleRazorpayWebhook(body, "0".repeat(64), evt("forged"));

    expect(unsigned.status).toBe("invalid");
    expect(forged.status).toBe("invalid");

    const [order] = await db.select().from(orders).where(eq(orders.id, authorized.orderId));
    expect(order.state).toBe("pending_payment"); // untouched
  });

  it("settles an order the browser never confirmed", async () => {
    const before = await available(variantId);
    const authorized = await pendingOrder();
    expect(await available(variantId)).toBe(before - 1); // reserved

    const body = event("payment.captured", authorized.gatewayOrderId);
    const result = await handleRazorpayWebhook(body, sign(body), evt("captured"));

    expect(result.status).toBe("processed");
    const [order] = await db.select().from(orders).where(eq(orders.id, authorized.orderId));
    expect(order.state).toBe("paid");

    // Reservation converted to a real decrement — sold once, not twice.
    expect(await available(variantId)).toBe(before - 1);
    const [payment] = await db.select().from(payments).where(eq(payments.orderId, order.id));
    expect(payment.state).toBe("captured");
  });

  it("ignores a retry of the same event", async () => {
    const authorized = await pendingOrder();
    const body = event("payment.captured", authorized.gatewayOrderId);

    const first = await handleRazorpayWebhook(body, sign(body), evt("retry"));
    const stockAfterFirst = await available(variantId);
    const second = await handleRazorpayWebhook(body, sign(body), evt("retry"));

    expect(first.status).toBe("processed");
    expect(second.status).toBe("duplicate");
    expect(await available(variantId)).toBe(stockAfterFirst); // no second decrement
  });

  it("releases held stock when the gateway reports failure", async () => {
    const before = await available(variantId);
    const authorized = await pendingOrder();
    const body = event("payment.failed", authorized.gatewayOrderId, "pay_failed_1");

    const result = await handleRazorpayWebhook(body, sign(body), evt("failed"));

    expect(result.status).toBe("processed");
    const [order] = await db.select().from(orders).where(eq(orders.id, authorized.orderId));
    expect(order.state).toBe("payment_failed");
    expect(await available(variantId)).toBe(before); // hold returned to sale
  });

  it("never un-pays an order that already succeeded", async () => {
    const authorized = await pendingOrder();
    const paid = event("payment.captured", authorized.gatewayOrderId);
    await handleRazorpayWebhook(paid, sign(paid), evt("order_paid"));

    // A late failure event for the same order must not reverse it.
    const failed = event("payment.failed", authorized.gatewayOrderId, "pay_late_fail");
    const result = await handleRazorpayWebhook(failed, sign(failed), evt("late_fail"));

    expect(result.status).toBe("ignored");
    const [order] = await db.select().from(orders).where(eq(orders.id, authorized.orderId));
    expect(order.state).toBe("paid");
  });

  it("ignores events that reference no known order", async () => {
    const body = event("payment.captured", "order_does_not_exist");
    const result = await handleRazorpayWebhook(body, sign(body), evt("unknown"));
    expect(result.status).toBe("ignored");
  });
});
