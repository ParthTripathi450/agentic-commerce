import type { Diagnosis } from "./diagnose";

/**
 * DETERMINE — what, if anything, should be done about it.
 *
 * Pure, and a decision TABLE rather than a model call. The stage decides
 * whether to message a shopper, discount their basket or stop entirely, and
 * those are consequences a merchant is entitled to predict from their settings
 * rather than discover from a transcript. A model that chose here would make
 * the same case resolve differently on two runs for no stated reason.
 *
 * The model's only job in this whole agent is phrasing an outreach message from
 * facts the case already contains — and even that is optional, with a
 * deterministic template behind it.
 */

export type RecoveryActionType =
  | "retry_link"
  | "message"
  | "incentive"
  | "wait"
  | "escalate"
  | "stop";

export type RecoveryDecision = {
  action: RecoveryActionType;
  /** Why this and not something else — shown on the case, not just logged. */
  rationale: string;
  /** For `incentive`: the discount proposed, before the policy engine sees it. */
  discountBp?: number;
  discountMinor?: number;
  /** For `wait`: how long, in hours. */
  waitHours?: number;
  /** Set on `stop` and `escalate`. Never empty when set. */
  stopReason?: string;
};

/**
 * Limits the agent will not cross on its own.
 *
 * These are the merchant's, resolved by the policy engine; the defaults here
 * are only what an unconfigured merchant gets, and they are deliberately
 * conservative — an agent that messages twice and stops is recoverable from,
 * one that messages ten times has already cost the merchant the customer.
 */
export type RecoveryLimits = {
  maxRetries: number;
  maxMessages: number;
  maxDiscountBp: number;
  maxDiscountMinor: number;
  /** Below this, the case is not worth an intervention at all. */
  minValueMinor: number;
};

export const DEFAULT_RECOVERY_LIMITS: RecoveryLimits = {
  maxRetries: 2,
  maxMessages: 2,
  maxDiscountBp: 1000,
  maxDiscountMinor: 50_000,
  minValueMinor: 20_000,
};

export type CaseState = {
  diagnosis: Diagnosis;
  amountAtRiskMinor: number;
  retryCount: number;
  messageCount: number;
  incentiveMinor: number;
  /**
   * How long the money has been at risk — measured from the basket being
   * abandoned or the payment failing, NOT from when this system noticed.
   *
   * The difference matters the first time a merchant ever runs a sweep: every
   * case is seconds old and every basket is days old, and waiting an hour
   * "to give them a chance to come back" on a basket abandoned last week is
   * an hour of pretending.
   */
  hoursAtRisk: number;
  /** True once the money has been seen to arrive. */
  alreadyRecovered: boolean;
};

/**
 * The whole decision, in one pass, with the stopping rules FIRST.
 *
 * Order matters here and it is the point of the stage: every reason to stop is
 * evaluated before any reason to act, so no combination of inputs can produce
 * a third message or a fourth retry. A rule that only usually stops is not a
 * stopping rule.
 */
export function determineAction(state: CaseState, limits: RecoveryLimits): RecoveryDecision {
  const { diagnosis } = state;

  // ---------------------------------------------------------- stop first
  if (state.alreadyRecovered) {
    return {
      action: "stop",
      rationale: "The money already came back; there is nothing left to recover.",
      stopReason: "Recovered",
    };
  }

  if (state.messageCount >= limits.maxMessages && state.retryCount >= limits.maxRetries) {
    return {
      action: "stop",
      rationale:
        `Every allowed action has been used: ${state.messageCount} of ${limits.maxMessages} messages ` +
        `and ${state.retryCount} of ${limits.maxRetries} retries. Continuing would be pestering.`,
      stopReason: `Attempt limits reached (${limits.maxMessages} messages, ${limits.maxRetries} retries)`,
    };
  }

  if (!diagnosis.recoverable) {
    /*
     * Not recoverable by an agent is not the same as not recoverable.
     *
     * A shopper whose card has failed four times may still buy — but not
     * because software asked them again. This goes to a person with the
     * reasoning attached, rather than being closed.
     */
    return {
      action: "escalate",
      rationale: diagnosis.summary,
      stopReason: `Automated recovery stopped: ${diagnosis.summary}`,
    };
  }

  if (diagnosis.category === "unknown") {
    return {
      action: "escalate",
      rationale:
        "Why this failed is not known, and choosing an intervention for an unknown cause risks " +
        "telling the shopper something untrue. A person should look.",
      stopReason: "Cause unknown — escalated rather than guessed",
    };
  }

  if (state.amountAtRiskMinor < limits.minValueMinor) {
    /*
     * Small baskets are not worth an intervention.
     *
     * Not because the money does not count, but because the cheapest possible
     * action — a message — still spends the shopper's attention and the
     * merchant's goodwill, and both are worth more than a ₹150 basket.
     */
    return {
      action: "stop",
      rationale: `At ${state.amountAtRiskMinor / 100} this is below the value worth contacting a shopper about.`,
      stopReason: "Below the minimum value for an intervention",
    };
  }

  // ------------------------------------------------------- then the wait
  /*
   * Give the shopper a chance to come back on their own.
   *
   * The commonest "recovery" is someone finishing what they started twenty
   * minutes later, and an agent that messages instantly takes credit for that
   * while training shoppers to expect a discount for hesitating.
   */
  if (state.hoursAtRisk < 1 && state.messageCount === 0) {
    return {
      action: "wait",
      rationale: "Detected minutes ago. Shoppers often finish on their own; contacting them now would be premature.",
      waitHours: 1,
    };
  }

  // ------------------------------------------------------------- then act
  if (diagnosis.category === "likely_temporary" && state.retryCount < limits.maxRetries) {
    return {
      action: "retry_link",
      rationale:
        "The failure looks transient, so the shopper gets a link straight back to the same basket " +
        "at the same price. Nothing is charged without them.",
    };
  }

  if (state.messageCount < limits.maxMessages) {
    const isSecondTry = state.messageCount > 0;
    const highValue = state.amountAtRiskMinor >= limits.maxDiscountMinor * 4;

    /*
     * An incentive is the LAST lever, not the first.
     *
     * Offering money before asking is how a merchant teaches shoppers to
     * abandon baskets deliberately. It is proposed only on a second contact,
     * and only where the basket is large enough for the discount to be worth
     * less than the sale.
     */
    if (isSecondTry && highValue && state.incentiveMinor === 0) {
      const proposedBp = Math.min(limits.maxDiscountBp, 1000);
      const proposedMinor = Math.min(
        Math.round((state.amountAtRiskMinor * proposedBp) / 10_000),
        limits.maxDiscountMinor,
      );
      return {
        action: "incentive",
        rationale:
          `A first message did not bring them back and the basket is worth ` +
          `${Math.round(state.amountAtRiskMinor / 100)}. A bounded discount is worth less than losing it.`,
        discountBp: proposedBp,
        discountMinor: proposedMinor,
      };
    }

    return {
      action: "message",
      rationale: isSecondTry
        ? "A second and final reminder, with the basket still held at the price they saw."
        : "A first reminder that the basket is still there.",
    };
  }

  return {
    action: "stop",
    rationale: `${state.messageCount} messages have been sent and the limit is ${limits.maxMessages}.`,
    stopReason: `Message limit reached (${limits.maxMessages})`,
  };
}
