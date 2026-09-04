/**
 * DIAGNOSE — why is this revenue at risk?
 *
 * Pure, no database, no model. The whole stage is a mapping from evidence the
 * system actually has to one of a small set of conclusions, and the reason it
 * is pure is that a wrong diagnosis picks a wrong intervention: telling a
 * shopper "your card was declined, try another" when the gateway timed out is
 * both false and useless.
 *
 * **`unknown` is a first-class answer, not a fallback nobody reaches.** Most
 * real gateway failures arrive as a terse string or nothing at all, and a
 * diagnosis engine that always produces a specific cause is one that is
 * confidently wrong most of the time. Where the evidence does not distinguish
 * between "the card was refused" and "the customer closed the tab", this says
 * so and the case escalates to a human instead of guessing.
 */

export type DiagnosisCategory =
  | "likely_temporary"
  | "customer_action_required"
  | "repeated_failure"
  | "abandoned_before_payment"
  | "abandoned_at_payment"
  | "unknown";

export type Diagnosis = {
  category: DiagnosisCategory;
  /** How far the evidence goes. Never "high" on a guess. */
  confidence: "low" | "medium" | "high";
  /** Plain statement of what was concluded, for the case timeline. */
  summary: string;
  /** The signals it was concluded FROM, so it can be argued with. */
  basis: string[];
  /** Whether recovery is worth attempting at all. */
  recoverable: boolean;
};

/**
 * Failure strings that genuinely identify a cause.
 *
 * Deliberately small. Every entry here is a phrase gateways actually return,
 * and anything not on it lands in `unknown` rather than being pattern-matched
 * into the nearest plausible bucket — §8.21's rule, applied where the cost of
 * guessing is a shopper being told something untrue about their own bank.
 */
const TEMPORARY_SIGNALS = [
  "timeout",
  "timed out",
  "network",
  "gateway_error",
  "gateway error",
  "server_error",
  "internal error",
  "try again",
  "temporarily",
  "unavailable",
];

const CUSTOMER_ACTION_SIGNALS = [
  "insufficient",
  "declined",
  "do not honour",
  "do not honor",
  "card_declined",
  "expired_card",
  "expired card",
  "invalid_cvv",
  "incorrect_cvv",
  "authentication",
  "3ds",
  "otp",
  "limit exceeded",
];

const CUSTOMER_CANCELLED_SIGNALS = ["cancel", "abandoned by user", "user_cancel", "dismissed"];

export type FailureEvidence = {
  /** Whatever the gateway said. Often terse, often absent. */
  failureReason: string | null;
  /** How many times this shopper has failed with this merchant recently. */
  recentFailureCount: number;
  /** Attempts already made on THIS case. */
  priorAttempts: number;
};

export function diagnoseFailedPayment(evidence: FailureEvidence): Diagnosis {
  const basis: string[] = [];
  const reason = (evidence.failureReason ?? "").toLowerCase().trim();

  basis.push(
    reason ? `Gateway reported: "${evidence.failureReason}"` : "The gateway gave no failure reason",
  );
  basis.push(`${evidence.recentFailureCount} recent failed payment(s) from this shopper`);

  /*
   * Repetition outranks the reason string.
   *
   * A card that has been declined three times is not a temporary problem
   * however the third message is worded, and retrying it is how an agent turns
   * into a nuisance. This test comes first for that reason.
   */
  if (evidence.recentFailureCount >= 3) {
    return {
      category: "repeated_failure",
      confidence: "high",
      summary: `${evidence.recentFailureCount} payments have failed for this shopper. Retrying is unlikely to help and would be the third or fourth attempt.`,
      basis,
      recoverable: false,
    };
  }

  if (CUSTOMER_CANCELLED_SIGNALS.some((s) => reason.includes(s))) {
    return {
      category: "customer_action_required",
      confidence: "medium",
      summary: "The shopper stopped the payment themselves, so a retry needs them to come back.",
      basis,
      recoverable: true,
    };
  }

  if (CUSTOMER_ACTION_SIGNALS.some((s) => reason.includes(s))) {
    return {
      category: "customer_action_required",
      confidence: "high",
      summary:
        "The bank refused this payment for a reason only the shopper can resolve — another card or a corrected detail.",
      basis,
      recoverable: true,
    };
  }

  if (TEMPORARY_SIGNALS.some((s) => reason.includes(s))) {
    return {
      category: "likely_temporary",
      confidence: "medium",
      summary: "The failure looks like a transient gateway or network problem, which a later attempt often clears.",
      basis,
      recoverable: true,
    };
  }

  /*
   * Nothing usable. Say so.
   *
   * This is the common case in practice and the one worth getting right: an
   * empty or unrecognised reason means the system does not know why the money
   * did not arrive, and the honest response is to hand it to a person rather
   * than pick an intervention for a problem that may not exist.
   */
  return {
    category: "unknown",
    confidence: "low",
    summary: reason
      ? "The gateway's reason does not identify a cause this agent can act on."
      : "The gateway gave no reason, so why this payment failed is not known.",
    basis,
    recoverable: true,
  };
}

export type AbandonmentEvidence = {
  /** Did the shopper get as far as a payment attempt? */
  paymentAttempted: boolean;
  hoursSinceAbandoned: number;
  /** Earlier carts this shopper abandoned with this merchant. */
  priorAbandonments: number;
  /*
   * Value is deliberately NOT here. Whether a basket is worth chasing is a
   * DETERMINE question about the merchant's limits; whether it was abandoned
   * before or at payment is a DIAGNOSE question about the evidence. Taking an
   * input a stage does not use invites it to start using it.
   */
};

/**
 * Why a checkout was abandoned — as far as the evidence goes, which is not far.
 *
 * The distinction that IS evidenced is whether payment was attempted: a shopper
 * who never reached the payment step and one whose card failed at it are two
 * different problems with two different interventions. Everything past that —
 * price, shipping cost, second thoughts — is invisible to this system, and a
 * classification claiming otherwise would be invention.
 */
export function diagnoseAbandonment(evidence: AbandonmentEvidence): Diagnosis {
  const basis = [
    evidence.paymentAttempted
      ? "The shopper reached the payment step and did not complete it"
      : "The shopper left before attempting payment",
    `${Math.round(evidence.hoursSinceAbandoned)}h since the basket was last touched`,
    `${evidence.priorAbandonments} earlier abandoned basket(s) with this merchant`,
  ];

  if (evidence.priorAbandonments >= 3) {
    return {
      category: "repeated_failure",
      confidence: "medium",
      summary:
        "This shopper abandons baskets routinely, so a reminder is unlikely to change the outcome and would be the fourth.",
      basis,
      recoverable: false,
    };
  }

  if (evidence.paymentAttempted) {
    return {
      category: "abandoned_at_payment",
      confidence: "high",
      summary:
        "The basket was lost at the payment step — the shopper had decided to buy and something stopped them paying.",
      basis,
      recoverable: true,
    };
  }

  return {
    category: "abandoned_before_payment",
    confidence: "high",
    summary: "The basket was left before payment was attempted. Why is not recorded anywhere.",
    basis,
    recoverable: true,
  };
}

/**
 * A shopper whose payments keep failing across orders.
 *
 * Distinct from a single failed payment: the subject here is the SHOPPER's
 * ability to pay this merchant at all, and the useful response is to stop
 * automated attempts rather than work each order separately.
 */
export function diagnoseDegradation(evidence: {
  failureCount: number;
  windowHours: number;
  distinctOrders: number;
}): Diagnosis {
  return {
    category: "repeated_failure",
    confidence: evidence.failureCount >= 4 ? "high" : "medium",
    summary:
      `${evidence.failureCount} payments across ${evidence.distinctOrders} orders have failed in ` +
      `${Math.round(evidence.windowHours)}h. Something is wrong with this shopper's payment method, ` +
      `not with any one order.`,
    basis: [
      `${evidence.failureCount} failed payments in ${Math.round(evidence.windowHours)}h`,
      `spanning ${evidence.distinctOrders} separate orders`,
    ],
    recoverable: false,
  };
}
