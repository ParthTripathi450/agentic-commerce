import type { Criterion } from "@/lib/agent-types";
import type { ShoppingTurn } from "./agent";

/**
 * Wire format for a shopping turn.
 *
 * Explicit rather than shipping internal objects: the client receives exactly
 * the scoring facts the explanation was built from, so the UI can show the same
 * reasoning the agent used — and nothing it did not.
 */
export type OptionDto = {
  rank: number;
  productId: string;
  variantId: string;
  title: string;
  brand: string | null;
  category: string;
  merchant: { id: string; slug: string; name: string };
  priceMinor: number;
  compareAtPriceMinor: number | null;
  currency: string;
  variantAttributes: Record<string, string>;
  availableQuantity: number;
  deliveryDays: number;
  returnWindowDays: number;
  returnsAccepted: boolean;
  ratingBp: number | null;
  ratingCount: number;
  imageUrl: string | null;
  score: number;
  criteria: Criterion[];
};

export type TurnDto = {
  sessionId: string;
  outcome: "results" | "no_results" | "needs_clarification";
  message: string | null;
  narrative: string | null;
  /** Short scannable reasons, generated from the score vector. */
  points: string[];
  intent: {
    productQuery: string;
    category: string | null;
    attributes: Record<string, string>;
    priceMaxMinor: number | null;
    priority: string;
    quantity: number;
  };
  options: OptionDto[];
  comparisons: Array<{ rank: number; label: string; summary: string; deltas: string[] }>;
  excluded: Array<{ label: string; reason: string }>;
  relaxations: Array<{ constraint: string; from: string; to: string; reason: string }>;
  weights: Record<string, number>;
  stats: {
    recalled: number;
    considered: number;
    accepted: number;
    merchantsSearched: number;
    durationMs: number;
  };
  provenance: { provider: string; model: string; degraded: boolean };
};

export function toTurnDto(turn: ShoppingTurn): TurnDto {
  return {
    sessionId: turn.sessionId,
    outcome: turn.outcome,
    message: turn.message,
    narrative: turn.explanation?.narrative ?? null,
    points: turn.explanation?.points ?? [],
    intent: {
      productQuery: turn.intent.productQuery,
      category: turn.intent.category,
      attributes: turn.intent.attributes,
      priceMaxMinor: turn.intent.priceMaxMinor,
      priority: turn.intent.priority,
      quantity: turn.intent.quantity,
    },
    options: turn.ranking.ranked.map((item) => ({
      rank: item.rank,
      productId: item.candidate.productId,
      variantId: item.candidate.variant.id,
      title: item.candidate.title,
      brand: item.candidate.brand,
      category: item.candidate.category,
      merchant: {
        id: item.candidate.merchant.id,
        slug: item.candidate.merchant.slug,
        name: item.candidate.merchant.name,
      },
      priceMinor: item.candidate.variant.priceMinor,
      compareAtPriceMinor: item.candidate.variant.compareAtPriceMinor,
      currency: item.candidate.variant.currency,
      variantAttributes: item.candidate.variant.attributes,
      availableQuantity: item.candidate.variant.availableQuantity,
      deliveryDays: item.candidate.policies.standardDeliveryDays,
      returnWindowDays: item.candidate.policies.returnWindowDays,
      returnsAccepted: item.candidate.policies.returnsAccepted,
      ratingBp: item.candidate.ratingBp,
      ratingCount: item.candidate.ratingCount,
      imageUrl: item.candidate.imageUrls[0] ?? null,
      score: item.score,
      criteria: item.criteria,
    })),
    comparisons:
      turn.explanation?.comparisons.map((c) => ({
        rank: c.rank,
        label: c.label,
        summary: c.summary,
        deltas: c.deltas,
      })) ?? [],
    excluded: turn.ranking.rejectedAlternatives
      .slice(0, 8)
      .map((r) => ({ label: r.label, reason: r.reason })),
    relaxations: turn.relaxations,
    weights: (turn.ranking.weights ?? {}) as unknown as Record<string, number>,
    stats: turn.stats,
    provenance: {
      provider: turn.explanation?.meta.provider ?? "deterministic-fallback",
      model: turn.explanation?.meta.model ?? "rule-based",
      degraded: turn.degraded,
    },
  };
}
