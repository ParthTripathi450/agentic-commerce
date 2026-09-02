import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  checkoutSessions,
  inventory,
  merchants,
  productVariants,
  products,
} from "@/db/schema";
import { addToCart } from "./cart";
import { prepareCheckout } from "./checkout";
import { releaseExpiredCheckouts, reconcileReservations } from "./expiry";
import { resetGatewayCache } from "./gateway";
import { emptyOpenCarts, ensureStock, provisionTestShopper } from "./test-utils";

let userId: string;
let variantId: string;

/**
 * addToCart intentionally ACCUMULATES into an open cart, so tests must start
 * from an empty one or quantities carry over between runs and trip the
 * per-order spending limit.
 */
async function freshCart() {
  await emptyOpenCarts(userId);
  const cart = await addToCart({ userId, variantId, quantity: 1 });
  return cart.id;
}

async function reserved(id: string) {
  const [row] = await db.select({ reserved: inventory.reserved }).from(inventory).where(eq(inventory.variantId, id));
  return Number(row.reserved);
}

beforeAll(async () => {
  process.env.PAYMENT_GATEWAY = "mock";
  resetGatewayCache();
  userId = await provisionTestShopper("expiry-test@acp.test", "Expiry Test");
  const [merchant] = await db.select().from(merchants).where(eq(merchants.slug, "voltix-electronics")).limit(1);
  const [variant] = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(eq(products.merchantId, merchant.id), sql`${products.title} LIKE 'ChronoFit%'`))
    .limit(1);
  variantId = variant.id;

  // Pin stock so the suite is repeatable: these tests really do sell units.
  await ensureStock(variantId, 50);
});

describe("abandoned checkout cleanup", () => {
  it("releases stock held by a checkout nobody completed", async () => {
    await reconcileReservations();
    const before = await reserved(variantId);

    const cartId = await freshCart();
    const proposal = await prepareCheckout({ userId, cartId, intentText: "abandoned" });
    if (proposal.status !== "requires_authorization") throw new Error("expected proposal");

    expect(await reserved(variantId)).toBe(before + 1); // held while deciding

    // Simulate the shopper walking away and the session ageing out.
    await db
      .update(checkoutSessions)
      .set({ expiresAt: sql`now() - interval '1 hour'` })
      .where(eq(checkoutSessions.id, proposal.checkoutSessionId));

    const result = await releaseExpiredCheckouts();
    expect(result.sessionsExpired).toBeGreaterThan(0);
    expect(await reserved(variantId)).toBe(before); // hold reclaimed

    const [session] = await db
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.id, proposal.checkoutSessionId));
    expect(session.state).toBe("expired");
  });

  it("reconciles reserved counts that have drifted", async () => {
    // The correct value is whatever live checkout sessions actually hold — not
    // necessarily zero, since other in-flight sessions may legitimately hold
    // this variant. Reconcile must restore exactly that, no more, no less.
    await reconcileReservations();
    const correct = await reserved(variantId);

    // Inject drift, as an interrupted process would leave behind.
    await db.update(inventory).set({ reserved: 99 }).where(eq(inventory.variantId, variantId));
    expect(await reserved(variantId)).toBe(99);

    await reconcileReservations();
    expect(await reserved(variantId)).toBe(correct);
  });

  it("always audits a checkout, even with no agent session supplied", async () => {
    const cartId = await freshCart();
    const proposal = await prepareCheckout({ userId, cartId, intentText: "unattended" });
    if (proposal.status !== "requires_authorization") throw new Error("expected proposal");

    expect(proposal.agentSessionId).toBeTruthy();
    const events = await db.execute<{ step: string }>(
      sql`SELECT step FROM agent_events WHERE session_id = ${proposal.agentSessionId}`,
    );
    const steps = (events as unknown as { step: string }[]).map((e) => e.step);
    expect(steps).toContain("POLICY_CHECK");
  });
});
