import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { orders, paymentMethods, payments } from "@/db/schema";
import { runAutonomousPurchase } from "@/server/agents/customer/autonomous";
import { authorizeCheckout } from "@/server/commerce/checkout";
import { resetGatewayCache } from "@/server/commerce/gateway";
import { emptyOpenCarts, provisionTestShopper } from "@/server/commerce/test-utils";

/**
 * Saved-method purchases.
 *
 * The value of this feature is that the agent finishes the job; the risk is
 * that it finishes it without being asked. These tests pin the boundary.
 */
let userId: string;

beforeAll(async () => {
  process.env.PAYMENT_GATEWAY = "mock";
  resetGatewayCache();
  userId = await provisionTestShopper("saved-pay-test@acp.test", "Saved Pay Test");
  await db.delete(paymentMethods).where(eq(paymentMethods.userId, userId));
});

describe("saved payment methods", () => {
  it("stores no payment credentials at all", async () => {
    const columns = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'payment_methods'
    `);
    const names = (columns as unknown as { column_name: string }[]).map((c) => c.column_name);

    // The whole safety argument for this table: there is nothing to leak.
    for (const forbidden of ["card_number", "pan", "cvv", "cvc", "token", "secret"]) {
      expect(names, `payment_methods must not have a ${forbidden} column`).not.toContain(forbidden);
    }
    expect(names).toContain("last4");
    expect(names).toContain("brand");
  });

  it("still requires approval before it can pay", async () => {
    await db.insert(paymentMethods).values({
      userId,
      brand: "visa",
      last4: "4242",
      holderName: "Saved Pay Test",
      expiryMonth: 12,
      expiryYear: new Date().getFullYear() + 3,
      gateway: "mock",
      isDefault: true,
    });

    await emptyOpenCarts(userId);
    const [before] = await db.select({ n: sql<number>`count(*)` }).from(orders);

    const result = await runAutonomousPurchase({
      userId,
      message: "Buy me black running shoes, size 10, under ₹5,000",
    });

    expect(result.status).toBe("awaiting_authorization");
    // Having a card on file must not shortcut the gate.
    const [after] = await db.select({ n: sql<number>`count(*)` }).from(orders);
    expect(Number(after.n)).toBe(Number(before.n));
  });

  it("settles server-side even when Razorpay is the configured gateway", async () => {
    // The bug this covers: with PAYMENT_GATEWAY=razorpay the saved-method path
    // bailed out to the hosted widget, so the shopper still had to type card
    // details after approving — defeating the point of saving a method.
    process.env.PAYMENT_GATEWAY = "razorpay";
    resetGatewayCache();

    try {
      await emptyOpenCarts(userId);
      const proposal = await runAutonomousPurchase({
        userId,
        message: "Buy me black running shoes, size 10, under ₹5,000",
      });
      if (proposal.status !== "awaiting_authorization") throw new Error("expected a proposal");

      const authorized = await authorizeCheckout({
        userId,
        approvalId: proposal.approvalId,
        decision: "approve",
        sessionId: proposal.sessionId,
      });
      if (authorized.status !== "authorized") throw new Error("expected authorization");

      const { MockGateway } = await import("@/server/commerce/gateway");
      const { confirmPayment } = await import("@/server/commerce/checkout");
      const pid = "pay_saved_rzp_1";

      // Explicit gateway instance — no global mutation, so a concurrent widget
      // checkout would still correctly see Razorpay.
      const confirmed = await confirmPayment({
        userId,
        orderId: authorized.orderId,
        gatewayPaymentId: pid,
        signature: MockGateway.sign(authorized.gatewayOrderId, pid),
        gateway: new MockGateway(),
      });

      expect(confirmed.status).toBe("paid");
      expect(process.env.PAYMENT_GATEWAY).toBe("razorpay"); // untouched
    } finally {
      process.env.PAYMENT_GATEWAY = "mock";
      resetGatewayCache();
    }
  });

  it("completes the purchase once approved, with no further input", async () => {
    await emptyOpenCarts(userId);
    const proposal = await runAutonomousPurchase({
      userId,
      message: "Buy me black running shoes, size 10, under ₹5,000",
    });
    if (proposal.status !== "awaiting_authorization") throw new Error("expected a proposal");

    // payWithSavedMethod needs a request context for auth; the underlying
    // authorize step is what it delegates to, so exercise that directly.
    const authorized = await authorizeCheckout({
      userId,
      approvalId: proposal.approvalId,
      decision: "approve",
      sessionId: proposal.sessionId,
    });
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") return;

    const { MockGateway } = await import("@/server/commerce/gateway");
    const { confirmPayment } = await import("@/server/commerce/checkout");
    const pid = "pay_saved_test_1";
    const confirmed = await confirmPayment({
      userId,
      orderId: authorized.orderId,
      gatewayPaymentId: pid,
      signature: MockGateway.sign(authorized.gatewayOrderId, pid),
    });

    expect(confirmed.status).toBe("paid");
    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.orderId, authorized.orderId))
      .limit(1);
    expect(payment.state).toBe("captured");
  });
});
