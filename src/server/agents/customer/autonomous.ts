import { formatMoney } from "@/lib/money";
import { record } from "@/server/audit/recorder";
import { startDirectPurchase } from "@/server/commerce/cart";
import { prepareCheckout } from "@/server/commerce/checkout";
import { createIntentMandate } from "@/server/protocols/ap2/mandates";
import { runShoppingTurn } from "./agent";
import { compareToWinner } from "./ranker";
import type { OptionDto } from "./dto";

/**
 * Autonomous purchase.
 *
 * The agent runs the entire journey unattended — understand, search, rank,
 * explain, choose, build the cart, sign the mandate chain — and then STOPS at a
 * single human authorization gate.
 *
 * That last gate is not a formality to be optimised away: it is the whole
 * safety model. Everything before it is reversible; the charge is not. So the
 * agent may assemble a purchase but never complete one.
 */

export type AutonomousOutcome =
  | {
      status: "awaiting_authorization";
      sessionId: string;
      approvalId: string;
      checkoutSessionId: string;
      cartMandateId: string;
      intentMandateId: string;
      /** What the agent decided to buy. */
      selected: OptionDto;
      /** The runners-up it rejected, with the concrete differences. */
      alternatives: Array<{
        option: OptionDto;
        summary: string;
        deltas: string[];
      }>;
      reasons: string[];
      /**
       * What buyers said about the pick, quoted verbatim.
       *
       * Weighs more here than anywhere: this flow spends money on the
       * shopper's behalf, so the one screen they read before authorising it
       * should carry evidence written by people rather than only the agent's
       * account of its own reasoning.
       */
      evidence: Array<{ body: string; ratingBp: number | null }>;
      excluded: Array<{ label: string; reason: string }>;
      totals: {
        subtotalMinor: number;
        discountMinor: number;
        shippingMinor: number;
        taxMinor: number;
        totalMinor: number;
        currency: string;
      };
      merchantName: string;
      limitsSummary: string[];
      policyReason: string;
      provenance: { provider: string; model: string; degraded: boolean };
    }
  | {
      status: "stopped";
      sessionId: string;
      /** Which step stopped, so the shopper knows how far it got. */
      step: "search" | "policy" | "cart" | "clarify";
      reason: string;
      details: string[];
    };

export async function runAutonomousPurchase(input: {
  userId: string;
  message: string;
  quantity?: number;
  /**
   * A rated feature the shopper asked to prioritise.
   *
   * Passed through rather than re-derived: the autonomous run used to take a
   * single synthesised sentence and nothing else, so a shopper who answered
   * "comfort" to the prioritise question had that answer silently dropped
   * before anything was ranked. Everything they said has to reach the search,
   * or asking them was theatre.
   */
  focusQuality?: string | null;
}): Promise<AutonomousOutcome> {
  // Steps 1-4: the same audited pipeline the assisted flow uses.
  /*
   * Autonomous mode never asks.
   *
   * "Let the agent buy it for me" is a single instruction, not a conversation —
   * there is nobody at the keyboard to answer a clarifying question. It either
   * understands enough to choose, or it stops at the gate and says why.
   */
  const turn = await runShoppingTurn({
    userId: input.userId,
    message: input.message,
    limit: 5,
    skipQuestions: true,
    focusQuality: input.focusQuality ?? null,
  });

  if (turn.outcome === "needs_clarification") {
    return {
      status: "stopped",
      sessionId: turn.sessionId,
      step: "clarify",
      reason: turn.message ?? "I need more detail before I can buy anything.",
      details: [],
    };
  }

  if (turn.outcome === "no_results" || turn.ranking.ranked.length === 0) {
    return {
      status: "stopped",
      sessionId: turn.sessionId,
      step: "search",
      reason: turn.message ?? "Nothing matched what you asked for, so I bought nothing.",
      details: turn.ranking.rejectedAlternatives.slice(0, 4).map((r) => `${r.label} — ${r.reason}`),
    };
  }

  const { toTurnDto } = await import("./dto");
  const dto = toTurnDto(turn);
  const winner = turn.ranking.ranked[0];
  const selected = dto.options[0];

  // Step 5: SELECT — recorded as the AGENT's decision, not the shopper's.
  await record(turn.sessionId, {
    step: "SELECT",
    observation: {
      summary: `Chose ${winner.candidate.title} from ${winner.candidate.merchant.name} without asking.`,
      candidatesConsidered: turn.ranking.ranked.length,
    },
    reasoning: {
      summary: `Highest ranked at ${winner.score} on the published criteria.`,
      criteria: winner.criteria,
      rejectedAlternatives: turn.ranking.ranked.slice(1, 4).map((other) => ({
        ref: other.candidate.productId,
        label: `${other.candidate.title} — ${other.candidate.merchant.name}`,
        reason: compareToWinner(winner, other).deltas.join("; ") || "scored lower overall",
        score: other.score,
      })),
    },
    action: { type: "autonomous_select", params: { variantId: winner.candidate.variant.id } },
    outcome: { status: "ok" },
  });

  // The Intent Mandate captures what the shopper authorised in words, before
  // any cart exists — so the cart can later be checked against it.
  const intentMandate = await createIntentMandate({
    userId: input.userId,
    sessionId: turn.sessionId,
    naturalLanguageIntent: input.message,
    // "under ₹5,000" is a statement about the product, so it is recorded as an
    // item-price limit. The total (with GST and shipping) is bounded by the
    // policy engine and shown at the authorization gate.
    maxAmountMinor: null,
    maxItemPriceMinor: turn.intent.priceMaxMinor,
    category: turn.intent.category,
    requiredAttributes: turn.intent.attributes,
    allowedMerchantIds: [winner.candidate.merchant.id],
  });

  // Step 6: CART. Replace semantics — the agent buys what it chose, nothing else.
  let cartId: string;
  try {
    const cart = await startDirectPurchase({
      userId: input.userId,
      variantId: winner.candidate.variant.id,
      quantity: input.quantity ?? turn.intent.quantity ?? 1,
      agentSessionId: turn.sessionId,
    });
    cartId = cart.id;
  } catch (cause) {
    await record(turn.sessionId, {
      step: "CART",
      observation: { summary: "Tried to add the chosen item to a cart." },
      reasoning: { summary: "The item became unavailable between ranking and cart." },
      action: { type: "autonomous_cart", verdict: "DENY" },
      outcome: { status: "blocked", detail: (cause as Error).message },
    });
    return {
      status: "stopped",
      sessionId: turn.sessionId,
      step: "cart",
      reason: (cause as Error).message,
      details: [],
    };
  }

  // Step 7: policy + Cart Mandate. Stops short of charging, by design.
  const proposal = await prepareCheckout({
    userId: input.userId,
    cartId,
    sessionId: turn.sessionId,
    intentText: input.message,
    intentMandateId: intentMandate.id,
    agentIdentifier: "autonomous-agent/1.0",
  });

  if (proposal.status === "blocked") {
    return {
      status: "stopped",
      sessionId: turn.sessionId,
      step: "policy",
      reason: proposal.reason,
      details: proposal.issues,
    };
  }

  const alternatives = turn.ranking.ranked.slice(1, 3).map((other, index) => {
    const diff = compareToWinner(winner, other);
    return {
      option: dto.options[index + 1],
      summary: diff.summary,
      deltas: diff.deltas,
    };
  });

  return {
    status: "awaiting_authorization",
    sessionId: turn.sessionId,
    approvalId: proposal.approvalId,
    checkoutSessionId: proposal.checkoutSessionId,
    cartMandateId: proposal.cartMandateId,
    intentMandateId: proposal.intentMandateId,
    selected,
    alternatives,
    reasons: dto.points,
    evidence: dto.evidence,
    excluded: dto.excluded.slice(0, 4),
    totals: proposal.totals,
    merchantName: proposal.cart.merchant.name,
    limitsSummary: proposal.limitsSummary,
    policyReason: proposal.reason,
    provenance: dto.provenance,
  };
}

export { formatMoney };
