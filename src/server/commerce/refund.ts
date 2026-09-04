/**
 * Refund rules.
 *
 * Pure and dependency-free on purpose: this decides whether money may go back
 * and whether stock comes with it, which is exactly the kind of judgement that
 * must be unit-testable. The server action below it only does I/O.
 *
 * The subtle part is stock. Refunding is not one situation but three, and they
 * disagree about inventory:
 *
 *   paid      — the units never left the building, so they return to sale.
 *   fulfilled — the units were delivered. Whether they physically came back is
 *               not something this system can know, so it does NOT restock;
 *               inventing units would sell things that are not on the shelf.
 *   canceled  — `cancelOrderAction` already returned the stock. Restocking
 *               again would double-count it.
 *
 * Under-restocking is recoverable by hand; over-restocking sells phantom units.
 */

export type RefundPlan = {
  /** Charged amount, taken from the payment row rather than the order totals. */
  amountMinor: number;
  /** Carried on the plan so callers need no non-null assertion to use it. */
  gatewayPaymentId: string;
  restock: boolean;
  /** Merchant-facing explanation of the stock decision. */
  stockNote: string;
};

export type RefundEligibility = { ok: true; plan: RefundPlan } | { ok: false; error: string };

export type RefundInput = {
  orderState: string;
  /** Null when no payment row exists at all. */
  paymentState: string | null;
  paymentAmountMinor: number | null;
  gatewayPaymentId: string | null;
};

/** Order states from which a refund can be issued, with their stock decision. */
const REFUNDABLE_STATES: Record<string, { restock: boolean; stockNote: string }> = {
  paid: {
    restock: true,
    stockNote: "stock returned to inventory",
  },
  fulfilled: {
    restock: false,
    stockNote: "stock unchanged — the units were delivered; restock them by hand if they come back",
  },
  canceled: {
    restock: false,
    stockNote: "stock unchanged — cancelling this order already returned it",
  },
};

/**
 * Whether the merchant should even be offered a Refund control.
 *
 * Shares `REFUNDABLE_STATES` with `evaluateRefund` so the button and the action
 * can never disagree about what is refundable.
 */
export function canOfferRefund(orderState: string, hasCapturedPayment: boolean): boolean {
  return hasCapturedPayment && orderState in REFUNDABLE_STATES;
}

export function evaluateRefund(input: RefundInput): RefundEligibility {
  if (input.orderState === "refunded") {
    return { ok: false, error: "This order has already been refunded." };
  }

  const decision = REFUNDABLE_STATES[input.orderState];
  if (!decision) {
    return {
      ok: false,
      error: `Nothing was captured for a ${input.orderState.replace(/_/g, " ")} order, so there is nothing to refund.`,
    };
  }

  if (!input.paymentState) {
    return { ok: false, error: "No payment is recorded against this order." };
  }
  if (input.paymentState === "refunded") {
    return { ok: false, error: "The payment for this order is already refunded." };
  }
  if (input.paymentState !== "captured") {
    return {
      ok: false,
      error: `The payment is ${input.paymentState}, not captured — there is no money to return.`,
    };
  }

  if (!input.gatewayPaymentId) {
    return { ok: false, error: "This payment has no gateway reference to refund against." };
  }

  const amountMinor = input.paymentAmountMinor ?? 0;
  if (amountMinor <= 0) {
    return { ok: false, error: "The recorded payment amount is zero." };
  }

  return {
    ok: true,
    plan: {
      amountMinor,
      gatewayPaymentId: input.gatewayPaymentId,
      restock: decision.restock,
      stockNote: decision.stockNote,
    },
  };
}

/**
 * Is this order still inside the merchant's own returns window?
 *
 * The shopper-facing rule, and deliberately separate from `evaluateRefund`:
 * that answers "can this payment be returned at all", which is about the money
 * and is the same for everybody. This answers "is this shopper still entitled
 * to ask", which is the merchant's published policy and applies only to them —
 * a merchant refunding a year-old order out of goodwill is their business.
 *
 * Measured from when the order was PLACED. Delivery dates are not recorded, and
 * inventing one to be strict about would make the answer unverifiable by the
 * shopper reading the same policy.
 */
export function withinReturnWindow(input: {
  placedAt: Date;
  returnsAccepted: boolean;
  returnWindowDays: number;
  now?: Date;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.returnsAccepted) {
    return { ok: false, reason: "This seller does not accept returns on any order." };
  }

  const now = input.now ?? new Date();
  const elapsedDays = Math.floor((now.getTime() - input.placedAt.getTime()) / 86_400_000);
  if (elapsedDays > input.returnWindowDays) {
    return {
      ok: false,
      reason:
        `This order is ${elapsedDays} days old and the seller's returns window is ` +
        `${input.returnWindowDays} days. You can still message them from Support.`,
    };
  }
  return { ok: true };
}
