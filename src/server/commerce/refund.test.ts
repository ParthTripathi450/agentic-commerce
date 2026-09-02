import { describe, expect, it } from "vitest";
import { gatewayByName, MockGateway } from "./gateway";
import { canOfferRefund, evaluateRefund, type RefundInput } from "./refund";

/**
 * Refund invariants.
 *
 * The stock decision is the part worth pinning down: refunding is three
 * different situations wearing one button, and two of them must NOT restock.
 */

const captured = (over: Partial<RefundInput> = {}): RefundInput => ({
  orderState: "paid",
  paymentState: "captured",
  paymentAmountMinor: 507_200,
  gatewayPaymentId: "pay_TEST123",
  ...over,
});

function plan(input: RefundInput) {
  const result = evaluateRefund(input);
  if (!result.ok) throw new Error(`expected eligible, got: ${result.error}`);
  return result.plan;
}

function error(input: RefundInput) {
  const result = evaluateRefund(input);
  if (result.ok) throw new Error("expected ineligible");
  return result.error;
}

describe("evaluateRefund — stock", () => {
  it("returns stock for a paid order, because the units never shipped", () => {
    const p = plan(captured({ orderState: "paid" }));
    expect(p.restock).toBe(true);
    expect(p.stockNote).toContain("returned to inventory");
  });

  it("does NOT restock a fulfilled order — the units were delivered", () => {
    // Inventing units here would sell things that are not on the shelf.
    const p = plan(captured({ orderState: "fulfilled" }));
    expect(p.restock).toBe(false);
    expect(p.stockNote).toContain("delivered");
  });

  it("does NOT restock a cancelled order — cancelling already did", () => {
    // This is the double-count guard: cancelOrderAction returns stock itself.
    const p = plan(captured({ orderState: "canceled" }));
    expect(p.restock).toBe(false);
    expect(p.stockNote).toContain("already returned it");
  });
});

describe("evaluateRefund — eligibility", () => {
  it("refunds a cancelled-but-paid order, which is where the money is stranded", () => {
    expect(evaluateRefund(captured({ orderState: "canceled" })).ok).toBe(true);
  });

  it("refuses an order that is already refunded", () => {
    expect(error(captured({ orderState: "refunded", paymentState: "refunded" }))).toMatch(
      /already been refunded/i,
    );
  });

  it("refuses a payment that is already refunded even if the order lagged behind", () => {
    expect(error(captured({ paymentState: "refunded" }))).toMatch(/already refunded/i);
  });

  it("refuses states where nothing was ever captured", () => {
    expect(error(captured({ orderState: "pending_payment" }))).toMatch(/nothing to refund/i);
    expect(error(captured({ orderState: "payment_failed" }))).toMatch(/nothing to refund/i);
  });

  it("refuses an authorized-but-uncaptured payment", () => {
    expect(error(captured({ paymentState: "authorized" }))).toMatch(/not captured/i);
  });

  it("refuses when no payment row exists at all", () => {
    expect(error(captured({ paymentState: null }))).toMatch(/no payment is recorded/i);
  });

  it("refuses without a gateway reference to refund against", () => {
    expect(error(captured({ gatewayPaymentId: null }))).toMatch(/no gateway reference/i);
  });

  it("refuses a zero or missing amount", () => {
    expect(error(captured({ paymentAmountMinor: 0 }))).toMatch(/zero/i);
    expect(error(captured({ paymentAmountMinor: null }))).toMatch(/zero/i);
  });
});

describe("evaluateRefund — amount", () => {
  it("refunds what was charged, not what the order totalled", () => {
    // The payment row is authoritative: totals can be edited, a charge cannot.
    expect(plan(captured({ paymentAmountMinor: 507_200 })).amountMinor).toBe(507_200);
  });

  it("carries the gateway payment id so callers need no non-null assertion", () => {
    expect(plan(captured()).gatewayPaymentId).toBe("pay_TEST123");
  });
});

describe("canOfferRefund", () => {
  it("offers the control exactly where evaluateRefund would proceed", () => {
    for (const state of ["paid", "fulfilled", "canceled"]) {
      expect(canOfferRefund(state, true)).toBe(true);
      expect(evaluateRefund(captured({ orderState: state })).ok).toBe(true);
    }
  });

  it("hides the control when nothing was captured", () => {
    expect(canOfferRefund("paid", false)).toBe(false);
    expect(canOfferRefund("canceled", false)).toBe(false);
  });

  it("hides the control for states that were never refundable", () => {
    for (const state of ["pending_payment", "payment_failed", "refunded"]) {
      expect(canOfferRefund(state, true)).toBe(false);
    }
  });
});

describe("gateway resolution", () => {
  it("refunds through the rails the charge came in on, not the configured default", () => {
    // Saved-method purchases settle on MockGateway even while
    // PAYMENT_GATEWAY=razorpay; posting a mock payment id to Razorpay 400s.
    const previous = process.env.PAYMENT_GATEWAY;
    process.env.PAYMENT_GATEWAY = "razorpay";
    try {
      expect(gatewayByName("mock").name).toBe("mock");
      expect(gatewayByName("razorpay_test").name).toBe("razorpay_test");
    } finally {
      // Restored: other suites share this process and read the same variable.
      if (previous === undefined) delete process.env.PAYMENT_GATEWAY;
      else process.env.PAYMENT_GATEWAY = previous;
    }
  });
});

describe("MockGateway.refundPayment", () => {
  it("returns a processed refund for the exact amount asked", async () => {
    const refund = await new MockGateway().refundPayment({
      gatewayPaymentId: "pay_mock_123",
      amountMinor: 507_200,
    });

    expect(refund.status).toBe("processed");
    expect(refund.amountMinor).toBe(507_200);
    expect(refund.gatewayRefundId).toMatch(/^rfnd_mock_/);
    expect(refund.raw.payment_id).toBe("pay_mock_123");
  });

  it("mints a distinct id per refund", async () => {
    const gateway = new MockGateway();
    const a = await gateway.refundPayment({ gatewayPaymentId: "pay_a", amountMinor: 100 });
    const b = await gateway.refundPayment({ gatewayPaymentId: "pay_a", amountMinor: 100 });
    expect(a.gatewayRefundId).not.toBe(b.gatewayRefundId);
  });
});
