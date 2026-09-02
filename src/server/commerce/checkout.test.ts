import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  carts,
  inventory,
  merchants,
  orders,
  productVariants,
  products,
} from "@/db/schema";
import { addToCart, discardAgentCart, loadCart, startDirectPurchase } from "./cart";
import { resetGatewayCache } from "./gateway";
import { emptyOpenCarts, ensureStock, provisionTestShopper } from "./test-utils";
import { authorizeCheckout, confirmPayment, prepareCheckout } from "./checkout";
import { MockGateway } from "./gateway";

let userId: string;
let variantId: string;

async function availableStock(id: string) {
  const [row] = await db
    .select({ available: sql<number>`${inventory.quantity} - ${inventory.reserved}` })
    .from(inventory)
    .where(eq(inventory.variantId, id));
  return Number(row.available);
}

/** Fresh cart per test so reservations from one do not leak into the next. */
async function freshCart() {
  await emptyOpenCarts(userId);
  const cart = await addToCart({ userId, variantId, quantity: 1 });
  return cart.id;
}

beforeAll(async () => {
  // Hermetic: these tests exercise our orchestration, not Razorpay's uptime.
  // The real adapter is verified separately by `npm run doctor`.
  process.env.PAYMENT_GATEWAY = "mock";
  resetGatewayCache();

  userId = await provisionTestShopper("checkout-test@acp.test", "Checkout Test");

  const [merchant] = await db.select().from(merchants).where(eq(merchants.slug, "stride-athletics")).limit(1);
  const [variant] = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        eq(products.merchantId, merchant.id),
        sql`${productVariants.attributes}->>'color' = 'black'`,
        sql`${productVariants.attributes}->>'size' = '10'`,
        sql`${products.title} LIKE 'Velocity Run 3%'`,
      ),
    )
    .limit(1);
  variantId = variant.id;

  // Pin stock so the suite is repeatable: these tests really do sell units.
  await ensureStock(variantId, 50);

});

describe("checkout", () => {
  it("never charges without explicit authorization", async () => {
    const cartId = await freshCart();
    const result = await prepareCheckout({ userId, cartId, intentText: "test purchase" });

    expect(result.status).toBe("requires_authorization");
    if (result.status !== "requires_authorization") return;

    expect(result.approvalId).toBeTruthy();
    expect(result.cartMandateId).toBeTruthy();
    // Nothing exists as an order yet — the proposal stops short of paying.
    const placed = await db.select().from(orders).where(eq(orders.checkoutSessionId, result.checkoutSessionId));
    expect(placed).toHaveLength(0);
  });

  it("holds stock while authorization is pending and releases it on decline", async () => {
    const before = await availableStock(variantId);
    const cartId = await freshCart();
    const result = await prepareCheckout({ userId, cartId, intentText: "test purchase" });
    if (result.status !== "requires_authorization") throw new Error("expected proposal");

    expect(await availableStock(variantId)).toBe(before - 1); // reserved

    const declined = await authorizeCheckout({ userId, approvalId: result.approvalId, decision: "reject" });
    expect(declined.status).toBe("rejected");
    expect(await availableStock(variantId)).toBe(before); // released
  });

  it("completes a full authorize → pay → confirm flow and commits stock", async () => {
    const beforeStock = await availableStock(variantId);
    const cartId = await freshCart();
    const cart = await loadCart(cartId);

    const proposal = await prepareCheckout({ userId, cartId, intentText: "black running shoes size 10" });
    if (proposal.status !== "requires_authorization") throw new Error("expected proposal");

    const authorized = await authorizeCheckout({ userId, approvalId: proposal.approvalId, decision: "approve" });
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") return;
    expect(authorized.amountMinor).toBe(cart.totals.totalMinor);

    const gatewayPaymentId = "pay_mock_success_1";
    const confirmed = await confirmPayment({
      userId,
      orderId: authorized.orderId,
      gatewayPaymentId,
      signature: MockGateway.sign(authorized.gatewayOrderId, gatewayPaymentId),
    });

    expect(confirmed.status).toBe("paid");
    // Reservation converted into a real decrement: one unit sold, not two.
    expect(await availableStock(variantId)).toBe(beforeStock - 1);

    const [order] = await db.select().from(orders).where(eq(orders.id, authorized.orderId));
    expect(order.state).toBe("paid");
  });

  it("refuses a payment whose gateway signature does not verify", async () => {
    const beforeStock = await availableStock(variantId);
    const cartId = await freshCart();
    const proposal = await prepareCheckout({ userId, cartId, intentText: "test" });
    if (proposal.status !== "requires_authorization") throw new Error("expected proposal");
    const authorized = await authorizeCheckout({ userId, approvalId: proposal.approvalId, decision: "approve" });
    if (authorized.status !== "authorized") throw new Error("expected authorization");

    const confirmed = await confirmPayment({
      userId,
      orderId: authorized.orderId,
      gatewayPaymentId: "pay_forged",
      signature: "0".repeat(64), // forged
    });

    expect(confirmed.status).toBe("failed");
    expect(confirmed.status === "failed" && confirmed.reason).toContain("not been charged");

    const [order] = await db.select().from(orders).where(eq(orders.id, authorized.orderId));
    expect(order.state).toBe("payment_failed");
    expect(await availableStock(variantId)).toBe(beforeStock); // stock released
  });

  it("is idempotent — confirming twice does not charge twice", async () => {
    const cartId = await freshCart();
    const proposal = await prepareCheckout({ userId, cartId, intentText: "test" });
    if (proposal.status !== "requires_authorization") throw new Error("expected proposal");
    const authorized = await authorizeCheckout({ userId, approvalId: proposal.approvalId, decision: "approve" });
    if (authorized.status !== "authorized") throw new Error("expected authorization");

    const pid = "pay_mock_idem";
    const sig = MockGateway.sign(authorized.gatewayOrderId, pid);
    const first = await confirmPayment({ userId, orderId: authorized.orderId, gatewayPaymentId: pid, signature: sig });
    const stockAfterFirst = await availableStock(variantId);
    const second = await confirmPayment({ userId, orderId: authorized.orderId, gatewayPaymentId: pid, signature: sig });

    expect(first.status).toBe("paid");
    expect(second.status).toBe("paid");
    expect(await availableStock(variantId)).toBe(stockAfterFirst); // no second decrement
  });

  it("cannot reuse an approval that was already decided", async () => {
    const cartId = await freshCart();
    const proposal = await prepareCheckout({ userId, cartId, intentText: "test" });
    if (proposal.status !== "requires_authorization") throw new Error("expected proposal");

    await authorizeCheckout({ userId, approvalId: proposal.approvalId, decision: "approve" });
    const replay = await authorizeCheckout({ userId, approvalId: proposal.approvalId, decision: "approve" });

    expect(replay.status).toBe("failed");
    expect(replay.status === "failed" && replay.reason).toContain("already");
  });
});


describe("a declined payment and the cart", () => {
  it("does not discard a basket the SHOPPER built", async () => {
    // Declining a payment is not the same as changing your mind about the item.
    const [pick] = (await db.execute(`
      SELECT v.id AS variant_id FROM product_variants v
      JOIN products p ON p.id = v.product_id
      JOIN inventory i ON i.variant_id = v.id
      WHERE v.active AND p.status='active' AND i.quantity > 5 LIMIT 1
    `)) as unknown as { variant_id: string }[];

    await emptyOpenCarts(userId);
    await ensureStock(pick.variant_id, 5);
    const cart = await addToCart({ userId, variantId: pick.variant_id, quantity: 1 });

    const [row] = await db.select().from(carts).where(eq(carts.id, cart.id));
    expect(row.agentSessionId).toBeNull();
    expect(await discardAgentCart(cart.id)).toBe(false);

    const after = await loadCart(cart.id);
    expect(after.lines.length).toBeGreaterThan(0);
  });

  it("discards a basket the AGENT assembled", async () => {
    const [pick] = (await db.execute(`
      SELECT v.id AS variant_id FROM product_variants v
      JOIN products p ON p.id = v.product_id
      JOIN inventory i ON i.variant_id = v.id
      WHERE v.active AND p.status='active' AND i.quantity > 5 LIMIT 1
    `)) as unknown as { variant_id: string }[];

    await emptyOpenCarts(userId);
    await ensureStock(pick.variant_id, 5);
    const cart = await startDirectPurchase({
      userId,
      variantId: pick.variant_id,
      quantity: 1,
      agentSessionId: "test-agent-session",
    });

    expect(await discardAgentCart(cart.id)).toBe(true);
    expect((await loadCart(cart.id)).lines).toHaveLength(0);
  });

  it("never wipes the shopper's existing basket to make room for a direct purchase", async () => {
    // startDirectPurchase used to delete every item in the open cart for that
    // merchant, so buying one thing silently discarded the rest.
    const picks = (await db.execute(`
      SELECT DISTINCT ON (p.merchant_id) v.id AS variant_id, p.merchant_id
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
      JOIN inventory i ON i.variant_id = v.id
      WHERE v.active AND p.status='active' AND i.quantity > 5
      ORDER BY p.merchant_id, v.id LIMIT 1
    `)) as unknown as { variant_id: string }[];

    await emptyOpenCarts(userId);
    await ensureStock(picks[0].variant_id, 8);
    const shopperCart = await addToCart({ userId, variantId: picks[0].variant_id, quantity: 2 });

    await startDirectPurchase({
      userId,
      variantId: picks[0].variant_id,
      quantity: 1,
      agentSessionId: "test-agent-session-2",
    });

    const still = await loadCart(shopperCart.id);
    expect(still.lines).toHaveLength(1);
    expect(still.lines[0].quantity).toBe(2);
  });
});
