import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { approvals, orders } from "@/db/schema";
import { authorizeCheckout } from "@/server/commerce/checkout";
import { resetGatewayCache } from "@/server/commerce/gateway";
import { emptyOpenCarts, provisionTestShopper } from "@/server/commerce/test-utils";
import { runAutonomousPurchase } from "./autonomous";

/**
 * The autonomous agent may assemble a purchase but never complete one.
 *
 * That boundary is the entire safety model of this mode, so it is asserted
 * directly rather than inferred from the UI.
 */
let userId: string;

async function orderCount() {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(orders);
  return Number(row.n);
}

beforeAll(async () => {
  process.env.PAYMENT_GATEWAY = "mock";
  resetGatewayCache();
  userId = await provisionTestShopper("autonomous-test@acp.test", "Autonomous Test");
});

describe("autonomous purchase", () => {
  it("chooses, signs the mandate chain, and stops at the authorization gate", async () => {
    await emptyOpenCarts(userId);
    const before = await orderCount();

    const result = await runAutonomousPurchase({
      userId,
      message: "Buy me black running shoes, size 10, under ₹5,000",
    });

    expect(result.status).toBe("awaiting_authorization");
    if (result.status !== "awaiting_authorization") return;

    // It committed to something, with both mandates in place.
    expect(result.selected.title).toBeTruthy();
    expect(result.cartMandateId).toBeTruthy();
    expect(result.intentMandateId).toBeTruthy();
    expect(result.totals.totalMinor).toBeGreaterThan(0);

    // And it stopped: no order exists yet.
    expect(await orderCount()).toBe(before);

    // The approval is pending a human, not pre-decided.
    const [approval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, result.approvalId))
      .limit(1);
    expect(approval.status).toBe("pending");
  });

  it("explains the choice and shows what it passed over", async () => {
    await emptyOpenCarts(userId);
    const result = await runAutonomousPurchase({
      userId,
      message: "Buy me black running shoes, size 10, under ₹5,000",
    });
    if (result.status !== "awaiting_authorization") throw new Error("expected a proposal");

    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
    // The runners-up carry concrete differences, not vague ranking talk.
    expect(result.alternatives.length).toBeGreaterThan(0);
    for (const alt of result.alternatives) {
      expect(alt.option.title).toBeTruthy();
      expect(alt.summary).toMatch(/Scored/);
    }
    // Internal scores must never surface to the shopper.
    for (const reason of result.reasons) {
      expect(reason).not.toMatch(/\b0\.\d{3,}\b/);
    }
  });

  it("buys exactly one item, not the whole cart", async () => {
    await emptyOpenCarts(userId);
    const result = await runAutonomousPurchase({
      userId,
      message: "Buy me black running shoes, size 10, under ₹5,000",
    });
    if (result.status !== "awaiting_authorization") throw new Error("expected a proposal");

    // Regression: an accidental second add-to-cart doubled the quantity.
    const unitPrice = result.selected.priceMinor;
    expect(result.totals.subtotalMinor).toBe(unitPrice);
  });

  it("stops without buying when nothing matches", async () => {
    await emptyOpenCarts(userId);
    const before = await orderCount();

    const result = await runAutonomousPurchase({
      userId,
      message: "Buy me a titanium submarine in size 47 under ₹200",
    });

    expect(result.status).toBe("stopped");
    if (result.status !== "stopped") return;
    expect(result.reason.length).toBeGreaterThan(10);
    expect(await orderCount()).toBe(before);
  });

  it("only creates an order once a human approves", async () => {
    await emptyOpenCarts(userId);
    const result = await runAutonomousPurchase({
      userId,
      message: "Buy me black running shoes, size 10, under ₹5,000",
    });
    if (result.status !== "awaiting_authorization") throw new Error("expected a proposal");

    const before = await orderCount();
    const authorized = await authorizeCheckout({
      userId,
      approvalId: result.approvalId,
      decision: "approve",
      sessionId: result.sessionId,
    });

    expect(authorized.status).toBe("authorized");
    expect(await orderCount()).toBe(before + 1);
  });

  it("creates nothing when the human denies", async () => {
    await emptyOpenCarts(userId);
    const result = await runAutonomousPurchase({
      userId,
      message: "Buy me black running shoes, size 10, under ₹5,000",
    });
    if (result.status !== "awaiting_authorization") throw new Error("expected a proposal");

    const before = await orderCount();
    const declined = await authorizeCheckout({
      userId,
      approvalId: result.approvalId,
      decision: "reject",
      sessionId: result.sessionId,
    });

    expect(declined.status).toBe("rejected");
    expect(await orderCount()).toBe(before);
  });
});
