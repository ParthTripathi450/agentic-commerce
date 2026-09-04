import { describe, expect, it } from "vitest";
import { diagnoseAbandonment, diagnoseDegradation, diagnoseFailedPayment } from "./diagnose";
import { DEFAULT_RECOVERY_LIMITS, determineAction, type CaseState } from "./determine";
import { composeMessage } from "./act";

/**
 * The guarantees this agent makes, as tests.
 *
 * Everything here is a pure stage, and that is the point: an agent that spends
 * money and contacts customers must be arguable from its inputs rather than
 * observed in production.
 */

const recoverable = diagnoseAbandonment({
  paymentAttempted: true,
  hoursSinceAbandoned: 5,
  priorAbandonments: 0,
});

const caseState = (over: Partial<CaseState> = {}): CaseState => ({
  diagnosis: recoverable,
  amountAtRiskMinor: 499_900,
  retryCount: 0,
  messageCount: 0,
  incentiveMinor: 0,
  hoursAtRisk: 5,
  alreadyRecovered: false,
  ...over,
});

describe("DIAGNOSE never invents a cause", () => {
  it("says unknown when the gateway said nothing", () => {
    const d = diagnoseFailedPayment({ failureReason: null, recentFailureCount: 0, priorAttempts: 0 });
    expect(d.category).toBe("unknown");
    expect(d.confidence).toBe("low");
  });

  it("says unknown for a reason it does not recognise", () => {
    // Razorpay's "signature does not match" is a real string this catalogue
    // produces, and it identifies nothing a shopper could act on. Guessing
    // "card declined" from it would tell them something untrue about their bank.
    const d = diagnoseFailedPayment({
      failureReason: "signature does not match",
      recentFailureCount: 0,
      priorAttempts: 0,
    });
    expect(d.category).toBe("unknown");
  });

  it("recognises a decline as needing the customer", () => {
    const d = diagnoseFailedPayment({
      failureReason: "card declined by issuing bank",
      recentFailureCount: 0,
      priorAttempts: 0,
    });
    expect(d.category).toBe("customer_action_required");
    expect(d.recoverable).toBe(true);
  });

  it("recognises a timeout as probably transient", () => {
    const d = diagnoseFailedPayment({
      failureReason: "gateway timeout",
      recentFailureCount: 0,
      priorAttempts: 0,
    });
    expect(d.category).toBe("likely_temporary");
  });

  it("lets repetition outrank the reason string", () => {
    // A card declined three times is not temporary however the third message
    // is worded, and retrying it is how an agent becomes a nuisance.
    const d = diagnoseFailedPayment({
      failureReason: "gateway timeout",
      recentFailureCount: 3,
      priorAttempts: 0,
    });
    expect(d.category).toBe("repeated_failure");
    expect(d.recoverable).toBe(false);
  });

  it("distinguishes only what the evidence distinguishes about abandonment", () => {
    const before = diagnoseAbandonment({ paymentAttempted: false, hoursSinceAbandoned: 3, priorAbandonments: 0 });
    const at = diagnoseAbandonment({ paymentAttempted: true, hoursSinceAbandoned: 3, priorAbandonments: 0 });

    expect(before.category).toBe("abandoned_before_payment");
    expect(at.category).toBe("abandoned_at_payment");
    // And says plainly that the reason is not recorded.
    expect(before.summary.toLowerCase()).toContain("not recorded");
  });

  it("carries the signals it concluded from, so it can be argued with", () => {
    const d = diagnoseDegradation({ failureCount: 4, windowHours: 72, distinctOrders: 3 });
    expect(d.basis.length).toBeGreaterThan(0);
    expect(d.recoverable).toBe(false);
  });
});

describe("DETERMINE stops, and stops first", () => {
  it("stops once every allowed action has been used", () => {
    const d = determineAction(
      caseState({ messageCount: 2, retryCount: 2 }),
      DEFAULT_RECOVERY_LIMITS,
    );
    expect(d.action).toBe("stop");
    expect(d.stopReason).toContain("limits reached");
  });

  it("never sends a third message, whatever else is true", () => {
    // The property that matters most: no combination of inputs may produce one
    // more contact than the merchant allowed.
    for (const amount of [50_000, 499_900, 10_000_000]) {
      for (const hours of [0.1, 5, 500]) {
        const d = determineAction(
          caseState({ messageCount: 2, amountAtRiskMinor: amount, hoursAtRisk: hours }),
          DEFAULT_RECOVERY_LIMITS,
        );
        expect(["stop", "escalate"], `${amount}/${hours}`).toContain(d.action);
      }
    }
  });

  it("escalates rather than guessing when the cause is unknown", () => {
    const unknown = diagnoseFailedPayment({ failureReason: null, recentFailureCount: 0, priorAttempts: 0 });
    const d = determineAction(caseState({ diagnosis: unknown }), DEFAULT_RECOVERY_LIMITS);
    expect(d.action).toBe("escalate");
    expect(d.stopReason).toContain("unknown");
  });

  it("escalates a repeated failure instead of retrying it", () => {
    const repeated = diagnoseFailedPayment({
      failureReason: "declined",
      recentFailureCount: 4,
      priorAttempts: 0,
    });
    const d = determineAction(caseState({ diagnosis: repeated }), DEFAULT_RECOVERY_LIMITS);
    expect(d.action).toBe("escalate");
  });

  it("does nothing at all about a small basket", () => {
    const d = determineAction(caseState({ amountAtRiskMinor: 9_900 }), DEFAULT_RECOVERY_LIMITS);
    expect(d.action).toBe("stop");
  });

  it("waits before the first contact on something that just happened", () => {
    const d = determineAction(caseState({ hoursAtRisk: 0.2 }), DEFAULT_RECOVERY_LIMITS);
    expect(d.action).toBe("wait");
  });

  it("does not wait on a basket abandoned days ago", () => {
    // Measured from the risk, not from when this system noticed — otherwise a
    // merchant's first ever sweep waits an hour on week-old baskets.
    const d = determineAction(caseState({ hoursAtRisk: 80 }), DEFAULT_RECOVERY_LIMITS);
    expect(d.action).not.toBe("wait");
  });

  it("stops the moment the money is seen to arrive", () => {
    const d = determineAction(caseState({ alreadyRecovered: true }), DEFAULT_RECOVERY_LIMITS);
    expect(d.action).toBe("stop");
    expect(d.stopReason).toBe("Recovered");
  });
});

describe("DETERMINE keeps incentives bounded and last", () => {
  it("never offers money on a first contact", () => {
    // Offering before asking teaches shoppers to abandon baskets deliberately.
    const d = determineAction(caseState({ messageCount: 0, hoursAtRisk: 5 }), DEFAULT_RECOVERY_LIMITS);
    expect(d.action).toBe("message");
    expect(d.discountMinor).toBeUndefined();
  });

  it("keeps a proposed discount inside both the percentage and cash caps", () => {
    // A percentage of a large basket is a large sum, and a merchant who capped
    // the percentage did not thereby agree to the cash.
    const huge = determineAction(
      caseState({ messageCount: 1, amountAtRiskMinor: 50_000_000 }),
      DEFAULT_RECOVERY_LIMITS,
    );
    expect(huge.action).toBe("incentive");
    expect(huge.discountMinor!).toBeLessThanOrEqual(DEFAULT_RECOVERY_LIMITS.maxDiscountMinor);
    expect(huge.discountBp!).toBeLessThanOrEqual(DEFAULT_RECOVERY_LIMITS.maxDiscountBp);
  });

  it("does not offer a second incentive on the same case", () => {
    const d = determineAction(
      caseState({ messageCount: 1, amountAtRiskMinor: 50_000_000, incentiveMinor: 50_000 }),
      DEFAULT_RECOVERY_LIMITS,
    );
    expect(d.action).toBe("message");
  });

  it("does not discount a basket barely bigger than the discount", () => {
    const d = determineAction(
      caseState({ messageCount: 1, amountAtRiskMinor: 60_000 }),
      DEFAULT_RECOVERY_LIMITS,
    );
    expect(d.action).toBe("message");
  });

  it("respects a merchant who turned the limits down", () => {
    const strict = { ...DEFAULT_RECOVERY_LIMITS, maxMessages: 1, maxRetries: 0 };
    const d = determineAction(caseState({ messageCount: 1 }), strict);
    expect(d.action).toBe("stop");
  });
});

describe("what the shopper reads is true", () => {
  it("states the amount and never claims a charge was made", () => {
    const { subject, body } = composeMessage({
      decision: { action: "message", rationale: "" },
      scenario: "failed_payment",
      amountAtRiskMinor: 499_900,
      merchantName: "Stride Athletics",
      link: "/orders",
    });
    expect(subject).toContain("4,999");
    expect(body).toContain("you have not been charged");
  });

  it("names the code and its expiry whenever it offers one", () => {
    // A code with no stated expiry is a code a shopper discovers has expired.
    const { body } = composeMessage({
      decision: { action: "incentive", rationale: "", discountMinor: 50_000 },
      scenario: "abandoned_checkout",
      amountAtRiskMinor: 499_900,
      merchantName: "Stride Athletics",
      code: "BACKAB12CD",
      codeExpiresHours: 72,
      link: "/cart",
    });
    expect(body).toContain("BACKAB12CD");
    expect(body).toContain("72h");
  });

  it("mentions no discount when none was granted", () => {
    const { body } = composeMessage({
      decision: { action: "message", rationale: "" },
      scenario: "abandoned_checkout",
      amountAtRiskMinor: 499_900,
      merchantName: "Stride Athletics",
      link: "/cart",
    });
    // "off" alone matches "left off" in the link sentence; what must be absent
    // is an offer — a code to use and a sum taken off.
    expect(body).not.toMatch(/\bUse\s+[A-Z0-9]{4,}/);
    expect(body).not.toMatch(/₹[\d,]+\s*off/);
  });
});
