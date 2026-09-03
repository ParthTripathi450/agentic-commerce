import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { agentPolicies, checkoutGroups, orders, payments } from "@/db/schema";
import { MockGateway, resetGatewayCache } from "./gateway";
import { combineTotals } from "./group-checkout";
import {
  authorizeGroupCheckout,
  confirmGroupPayment,
  prepareGroupCheckout,
} from "./group-checkout";
import { addToCart } from "./cart";
import { emptyOpenCarts, ensureStock, provisionTestShopper } from "./test-utils";

/**
 * One checkout, several merchants.
 *
 * The property that matters: the shopper authorises ONCE and pays ONCE, but
 * each merchant still gets their own order, their own Cart Mandate and their
 * own settlement row — because fulfilment and refunds are per-merchant.
 */

let userId: string;

beforeAll(async () => {
  process.env.PAYMENT_GATEWAY = "mock";
  resetGatewayCache();
  userId = await provisionTestShopper("group-checkout@acp.test", "Group Checkout Test");
});

describe("combineTotals", () => {
  const t = (over: Partial<ReturnType<typeof base>> = {}) => ({ ...base(), ...over });
  function base() {
    return {
      subtotalMinor: 100000, discountMinor: 0, shippingMinor: 5000,
      taxMinor: 18000, totalMinor: 123000, currency: "INR",
    };
  }

  it("sums every component across merchants", () => {
    const combined = combineTotals([t(), t()]);
    expect(combined.subtotalMinor).toBe(200000);
    expect(combined.totalMinor).toBe(246000);
  });

  it("does NOT deduplicate shipping — each merchant ships separately", () => {
    // Hiding the second shipping fee behind one total would misstate the price.
    const combined = combineTotals([t(), t(), t()]);
    expect(combined.shippingMinor).toBe(15000);
  });

  it("returns a zeroed total for no carts rather than throwing", () => {
    expect(combineTotals([]).totalMinor).toBe(0);
  });
});

describe("group checkout across two merchants", () => {
  it("produces one gateway order and one payment row per merchant", async () => {
    await emptyOpenCarts(userId);

    // Two variants from two different merchants.
    const picks = await db.execute<{ variant_id: string; merchant_id: string }>(`
      SELECT DISTINCT ON (p.merchant_id) v.id AS variant_id, p.merchant_id
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
      JOIN inventory i ON i.variant_id = v.id
      WHERE v.active AND p.status = 'active' AND i.quantity > 5
      -- Cheapest per merchant: test shoppers carry a Rs 40,000 order ceiling,
      -- and the catalogue now contains premium items that two of can exceed it
      -- before the test has set the ceiling it actually wants to prove.
      ORDER BY p.merchant_id, v.price_minor ASC
      LIMIT 2
    `);
    const rows = picks as unknown as { variant_id: string; merchant_id: string }[];
    expect(rows.length).toBe(2);

    for (const r of rows) {
      await ensureStock(r.variant_id, 5);
      await addToCart({ userId, variantId: r.variant_id, quantity: 1 });
    }

    const proposal = await prepareGroupCheckout({ userId });
    if (proposal.status !== "requires_authorization") {
      throw new Error(`expected a proposal, got: ${proposal.reason}`);
    }

    // One approval gesture, two merchant baskets.
    expect(proposal.lines).toHaveLength(2);
    expect(proposal.totals.totalMinor).toBe(
      proposal.lines.reduce((s, l) => s + l.proposal.totals.totalMinor, 0),
    );

    const authorized = await authorizeGroupCheckout({
      userId,
      groupId: proposal.groupId,
      approvalIds: proposal.lines.map((l) => l.proposal.approvalId),
      decision: "approve",
    });
    if (authorized.status !== "authorized") {
      throw new Error(`expected authorization, got: ${authorized.reason}`);
    }

    // TWO orders...
    expect(authorized.orderIds).toHaveLength(2);
    // ...but ONE charge.
    expect(authorized.amountMinor).toBe(proposal.totals.totalMinor);

    const paymentRows = await db
      .select()
      .from(payments)
      .where(eq(payments.gatewayOrderId, authorized.gatewayOrderId));
    expect(paymentRows).toHaveLength(2);
    expect(paymentRows.reduce((s, p) => s + p.amountMinor, 0)).toBe(authorized.amountMinor);

    // Each order carries the group so refunds and support stay per-merchant.
    const groupOrders = await db
      .select()
      .from(orders)
      .where(eq(orders.checkoutGroupId, proposal.groupId));
    expect(groupOrders).toHaveLength(2);
    expect(new Set(groupOrders.map((o) => o.merchantId)).size).toBe(2);

    // ---- settle the whole group with ONE signature ----
    const paymentId = `pay_group_${Date.now()}`;
    const confirmed = await confirmGroupPayment({
      userId,
      groupId: proposal.groupId,
      gatewayPaymentId: paymentId,
      signature: MockGateway.sign(authorized.gatewayOrderId, paymentId),
      gateway: new MockGateway(),
    });
    expect(confirmed.status).toBe("paid");

    const settled = await db.select().from(orders).where(eq(orders.checkoutGroupId, proposal.groupId));
    expect(settled.every((o) => o.state === "paid")).toBe(true);

    const [group] = await db
      .select()
      .from(checkoutGroups)
      .where(eq(checkoutGroups.id, proposal.groupId));
    expect(group.state).toBe("paid");
  });

  it("refuses a forged signature and charges nothing", async () => {
    await emptyOpenCarts(userId);
    const [pick] = (await db.execute<{ variant_id: string }>(`
      SELECT v.id AS variant_id FROM product_variants v
      JOIN products p ON p.id = v.product_id
      JOIN inventory i ON i.variant_id = v.id
      WHERE v.active AND p.status='active' AND i.quantity > 5 LIMIT 1
    `)) as unknown as { variant_id: string }[];
    await ensureStock(pick.variant_id, 5);
    await addToCart({ userId, variantId: pick.variant_id, quantity: 1 });

    const proposal = await prepareGroupCheckout({ userId });
    if (proposal.status !== "requires_authorization") throw new Error("expected a proposal");
    const authorized = await authorizeGroupCheckout({
      userId,
      groupId: proposal.groupId,
      approvalIds: proposal.lines.map((l) => l.proposal.approvalId),
      decision: "approve",
    });
    if (authorized.status !== "authorized") throw new Error("expected authorization");

    const result = await confirmGroupPayment({
      userId,
      groupId: proposal.groupId,
      gatewayPaymentId: "pay_forged",
      signature: "deadbeef",
      gateway: new MockGateway(),
    });

    expect(result.status).toBe("failed");
    const after = await db.select().from(orders).where(eq(orders.checkoutGroupId, proposal.groupId));
    expect(after.every((o) => o.state !== "paid")).toBe(true);
  });
});


describe("combined spending limits", () => {
  it("checks the GROUP total, not each basket in isolation", async () => {
    // A fresh shopper: `spentTodayMinor` counts this user's other orders, and
    // the tests above create some, which would skew the headroom arithmetic.
    const soloUser = await provisionTestShopper(
      `group-limit-${Date.now()}@acp.test`,
      "Group Limit Test",
    );
    await emptyOpenCarts(soloUser);

    const picks = (await db.execute(`
      SELECT DISTINCT ON (p.merchant_id) v.id AS variant_id
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
      JOIN inventory i ON i.variant_id = v.id
      WHERE v.active AND p.status = 'active' AND i.quantity > 5
      ORDER BY p.merchant_id, v.price_minor ASC
      LIMIT 2
    `)) as unknown as { variant_id: string }[];
    expect(picks.length).toBe(2);
    for (const p of picks) {
      await ensureStock(p.variant_id, 5);
      await addToCart({ userId: soloUser, variantId: p.variant_id, quantity: 1 });
    }

    // Learn the real per-merchant totals (tax and shipping included) before
    // choosing a ceiling, rather than guessing from unit prices.
    const open = await prepareGroupCheckout({ userId: soloUser });
    if (open.status !== "requires_authorization") {
      throw new Error(`expected an unrestricted proposal, got: ${open.reason}`);
    }
    expect(open.lines).toHaveLength(2);
    const each = open.lines.map((l) => l.proposal.totals.totalMinor);
    const combined = each[0] + each[1];

    // Comfortably above the larger basket, comfortably below the pair.
    const ceiling = Math.max(...each) + Math.floor((combined - Math.max(...each)) / 2);
    expect(ceiling).toBeGreaterThanOrEqual(Math.max(...each));
    expect(ceiling).toBeLessThan(combined);

    await db.insert(agentPolicies).values({
      scope: "user",
      scopeId: soloUser,
      limits: { maxDailySpendMinor: ceiling },
    });

    try {
      await emptyOpenCarts(soloUser);
      for (const p of picks) {
        await addToCart({ userId: soloUser, variantId: p.variant_id, quantity: 1 });
      }

      const result = await prepareGroupCheckout({ userId: soloUser });

      // Each basket fits under the ceiling on its own; splitting the purchase
      // across merchants must not become a way to spend past a daily limit.
      expect(result.status).toBe("blocked");
      if (result.status === "blocked") {
        expect(result.reason).toMatch(/daily limit/i);
        // Proof it was the COMBINED check, not both baskets failing alone.
        expect(result.issues).toHaveLength(0);
      }
    } finally {
      await db.delete(agentPolicies).where(eq(agentPolicies.scopeId, soloUser));
    }
  });
});
