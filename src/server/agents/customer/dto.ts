import type { Criterion } from "@/lib/agent-types";
import type { ShoppingTurn } from "./agent";
import { CRITERION_LABELS, type RankingResult } from "./ranker";

type RankedItem = RankingResult["ranked"][number];

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
  /**
   * The product's rated features (1–5), so a result card can show WHY it
   * matched — a shopper asking for waterproof should see the rating, not have
   * to open the product to find it.
   */
  qualities: Record<string, number>;
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
  outcome: "results" | "no_results" | "needs_clarification" | "asking" | "alternatives";
  message: string | null;
  /**
   * The question the agent is waiting on, when `outcome === "asking"`.
   *
   * Options are catalogue-derived quick replies; the shopper can always answer
   * in free text instead, which goes back through the same intent parser.
   */
  question: {
    id: string;
    question: string;
    rationale: string;
    skippable: boolean;
    options: { label: string; value: string }[];
  } | null;
  /** Slots already answered, echoed back so the client can return them. */
  answered: string[];
  /** What the agent believes so far, so the shopper can correct it. */
  known: string[];
  /**
   * Buyable near-misses, when the exact request could not be filled.
   *
   * Each carries the ways it differs, so the UI can never present a substitute
   * as a match.
   */
  alternatives: {
    option: OptionDto;
    differences: string[];
  }[];
  /** Constraints set aside to find them. */
  alternativesDropped: string[];
  /**
   * What the ranking weighted, most important first.
   *
   * Sent so the shopper can SEE the order that produced these results and
   * change it — a ranking whose priorities are hidden cannot be argued with.
   */
  criteria: { key: string; label: string; hint: string; weight: number }[];
  narrative: string | null;
  /** Short scannable reasons, generated from the score vector. */
  points: string[];
  /**
   * What buyers said about the pick, quoted verbatim.
   *
   * Carried separately from `points` because they come from a different place
   * and carry a different kind of authority: the points are the ranking
   * narrated, these are people. No model wrote or rewrote them.
   */
  evidence: Array<{ body: string; ratingBp: number | null }>;
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
  /** `productId` so a ruled-out item is still reachable — being ruled out for
   *  one query does not mean the shopper never wants to look at it. */
  excluded: Array<{ productId: string | null; label: string; reason: string }>;
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

/**
 * Projects a candidate onto the wire shape.
 *
 * Shared by ranked results and alternatives so a substitute card can never
 * drift from a result card — they are the same product, differently framed.
 */
/** Pulls the numeric feature ratings out of a product's attributes. */
function extractQualityScores(attributes: Record<string, unknown>): Record<string, number> {
  const raw = attributes?.qualities;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
}

function toOption(item: {
  candidate: RankedItem["candidate"];
  rank: number;
  score: number;
  criteria: Criterion[];
}): OptionDto {
  return {
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
    qualities: extractQualityScores(item.candidate.attributes),
    availableQuantity: item.candidate.variant.availableQuantity,
    deliveryDays: item.candidate.policies.standardDeliveryDays,
    returnWindowDays: item.candidate.policies.returnWindowDays,
    returnsAccepted: item.candidate.policies.returnsAccepted,
    ratingBp: item.candidate.ratingBp,
    ratingCount: item.candidate.ratingCount,
    imageUrl: item.candidate.imageUrls[0] ?? null,
    score: item.score,
    criteria: item.criteria,
  };
}

export function toTurnDto(turn: ShoppingTurn): TurnDto {
  return {
    sessionId: turn.sessionId,
    outcome: turn.outcome,
    message: turn.message,
    question: turn.question
      ? {
          id: turn.question.id,
          question: turn.question.question,
          rationale: turn.question.rationale,
          skippable: turn.question.skippable,
          options: turn.question.options,
        }
      : null,
    answered: turn.answered,
    known: turn.known,
    narrative: turn.explanation?.narrative ?? null,
    points: turn.explanation?.points ?? [],
    evidence:
      turn.explanation?.evidence.map((e) => ({ body: e.body, ratingBp: e.ratingBp })) ?? [],
    intent: {
      productQuery: turn.intent.productQuery,
      category: turn.intent.category,
      attributes: turn.intent.attributes,
      priceMaxMinor: turn.intent.priceMaxMinor,
      priority: turn.intent.priority,
      quantity: turn.intent.quantity,
    },
    options: turn.ranking.ranked.map(toOption),
    alternatives: turn.alternatives.map((a) => ({
      option: toOption({ candidate: a.candidate, rank: 0, score: 0, criteria: [] }),
      differences: a.differences,
    })),
    alternativesDropped: turn.alternativesDropped,
    criteria: turn.criteriaOrder.map((key) => ({
      key,
      label: CRITERION_LABELS[key].label,
      hint: CRITERION_LABELS[key].hint,
      weight: turn.ranking.weights[key] ?? 0,
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
      .map((r) => ({ productId: r.ref ?? null, label: r.label, reason: r.reason })),
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
