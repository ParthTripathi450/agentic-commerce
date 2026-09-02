import type { Criterion, RejectedAlternative } from "@/lib/agent-types";
import { formatMoney } from "@/lib/money";
import type { Candidate, Rejected } from "@/server/catalog/search";

/**
 * Deterministic ranking.
 *
 * No LLM involved: every candidate is scored on published criteria with
 * published weights, and the per-criterion contributions are returned alongside
 * the result. The explanation step later narrates *these numbers* — so the
 * stated reasons are always the reasons that actually decided the ranking.
 *
 * Same catalog + same query ⇒ same ranking, every time.
 */

export type Priority = "balanced" | "cheapest" | "fastest" | "best_quality" | "most_flexible";

export type Weights = {
  relevance: number;
  price: number;
  availability: number;
  delivery: number;
  returns: number;
  reliability: number;
  rating: number;
};

/** Weight presets. A stated shopper priority visibly re-weights the ranking. */
export const WEIGHT_PRESETS: Record<Priority, Weights> = {
  balanced:      { relevance: 0.22, price: 0.22, availability: 0.10, delivery: 0.10, returns: 0.08, reliability: 0.08, rating: 0.20 },
  cheapest:      { relevance: 0.12, price: 0.58, availability: 0.08, delivery: 0.06, returns: 0.04, reliability: 0.04, rating: 0.08 },
  fastest:       { relevance: 0.16, price: 0.12, availability: 0.18, delivery: 0.28, returns: 0.06, reliability: 0.10, rating: 0.10 },
  best_quality:  { relevance: 0.18, price: 0.08, availability: 0.08, delivery: 0.06, returns: 0.10, reliability: 0.20, rating: 0.30 },
  most_flexible: { relevance: 0.18, price: 0.12, availability: 0.10, delivery: 0.08, returns: 0.32, reliability: 0.10, rating: 0.10 },
};

/**
 * The criteria a shopper may reorder, and what each one means to them.
 *
 * `relevance` is deliberately NOT in this list. It is not a preference — it is
 * what keeps the ranking about the thing they asked for. Letting it be dragged
 * to last would rank a cheap unrelated product above a matching one, which is
 * the failure the relevance gate exists to prevent.
 */
export const SHOPPER_CRITERIA = [
  "price",
  "rating",
  "delivery",
  "returns",
  "reliability",
  "availability",
] as const;

export type ShopperCriterion = (typeof SHOPPER_CRITERIA)[number];

export const CRITERION_LABELS: Record<ShopperCriterion, { label: string; hint: string }> = {
  price: { label: "Price", hint: "Cheaper ranks higher" },
  rating: { label: "Rating", hint: "Better reviewed, weighted by how many reviews" },
  delivery: { label: "Delivery speed", hint: "Arrives sooner" },
  returns: { label: "Return window", hint: "Longer and easier to send back" },
  reliability: { label: "Seller reliability", hint: "Fulfils orders without problems" },
  availability: { label: "Stock", hint: "More on hand, less chance of a cancellation" },
};

/** Share of the score reserved for matching the request itself. */
const RELEVANCE_SHARE = 0.22;

/**
 * Turns a shopper's ordering into weights.
 *
 * Rank-proportional rather than winner-takes-all: the top choice matters most,
 * but the rest still count, so reordering shifts the ranking without collapsing
 * it to a single sort key. Anything the shopper omits keeps its place at the
 * end, so a partial order is still a valid one.
 */
export function weightsFromOrder(order: ShopperCriterion[]): Weights {
  const seen = new Set<ShopperCriterion>();
  const ordered: ShopperCriterion[] = [];
  for (const key of order) {
    if (SHOPPER_CRITERIA.includes(key) && !seen.has(key)) {
      seen.add(key);
      ordered.push(key);
    }
  }
  for (const key of SHOPPER_CRITERIA) if (!seen.has(key)) ordered.push(key);

  const n = ordered.length;
  const total = (n * (n + 1)) / 2;

  const weights = { relevance: RELEVANCE_SHARE } as Weights;
  ordered.forEach((key, index) => {
    weights[key] = ((n - index) / total) * (1 - RELEVANCE_SHARE);
  });
  return weights;
}

/** The order a preset implies, for showing the shopper where they are starting. */
export function orderFromWeights(weights: Weights): ShopperCriterion[] {
  return [...SHOPPER_CRITERIA].sort((a, b) => weights[b] - weights[a]);
}

/**
 * Reviews required before a rating is trusted at face value.
 *
 * Below this, the score is pulled toward the catalog average in proportion to
 * how little evidence there is — so a lone 5.0 from 3 reviews cannot outrank a
 * 4.6 backed by 900. This is a Bayesian (shrunk) average, the standard fix for
 * ranking by small-sample ratings.
 */
export const RATING_CONFIDENCE_REVIEWS = 50;

/** Neutral prior used when the candidate set has no ratings at all. */
const DEFAULT_PRIOR_BP = 4000;

export function confidenceAdjustedRatingBp(
  ratingBp: number | null,
  ratingCount: number,
  priorBp: number,
): number {
  if (!ratingBp || ratingCount <= 0) return priorBp;
  return Math.round(
    (ratingCount * ratingBp + RATING_CONFIDENCE_REVIEWS * priorBp) /
      (ratingCount + RATING_CONFIDENCE_REVIEWS),
  );
}

export type RankedCandidate = {
  rank: number;
  candidate: Candidate;
  score: number;
  criteria: Criterion[];
};

export type RankingResult = {
  ranked: RankedCandidate[];
  weights: Weights;
  priority: Priority;
  /** Losing candidates and filtered-out products, each with a concrete reason. */
  rejectedAlternatives: RejectedAlternative[];
};

/** Min-max normalisation. `higherIsBetter=false` inverts (cheaper/faster wins). */
function normalise(value: number, min: number, max: number, higherIsBetter: boolean): number {
  if (!Number.isFinite(value)) return 0;
  if (max === min) return 1; // no spread: this criterion cannot differentiate
  const ratio = (value - min) / (max - min);
  return higherIsBetter ? ratio : 1 - ratio;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function round(n: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export function rankCandidates(
  candidates: Candidate[],
  options: {
    priority?: Priority;
    budgetMinor?: number | null;
    weights?: Partial<Weights>;
    rejected?: Rejected[];
    limit?: number;
  } = {},
): RankingResult {
  const priority = options.priority ?? "balanced";
  const weights: Weights = { ...WEIGHT_PRESETS[priority], ...options.weights };

  if (candidates.length === 0) {
    return { ranked: [], weights, priority, rejectedAlternatives: toRejectedAlternatives(options.rejected ?? []) };
  }

  const prices = candidates.map((c) => c.variant.priceMinor);
  const stocks = candidates.map((c) => c.variant.availableQuantity);
  const deliveries = candidates.map((c) => c.policies.standardDeliveryDays);
  const returnDays = candidates.map((c) => (c.policies.returnsAccepted ? c.policies.returnWindowDays : 0));
  const reliabilities = candidates.map((c) => c.merchant.fulfillmentRateBp);
  // Prior is this result set's own average, so "good" is judged in context.
  const rated = candidates.filter((c) => c.ratingBp && c.ratingCount > 0);
  const priorBp = rated.length
    ? Math.round(rated.reduce((sum, c) => sum + (c.ratingBp ?? 0), 0) / rated.length)
    : DEFAULT_PRIOR_BP;
  const adjustedRatings = candidates.map((c) =>
    confidenceAdjustedRatingBp(c.ratingBp, c.ratingCount, priorBp),
  );
  const ratings = adjustedRatings;
  const relevances = candidates.map((c) => c.retrieval.rrf);

  const bounds = {
    price: { min: Math.min(...prices), max: Math.max(...prices) },
    // Stock depth beyond 10 units carries no extra signal for a single purchase.
    stock: { min: Math.min(...stocks.map((s) => Math.min(s, 10))), max: Math.max(...stocks.map((s) => Math.min(s, 10))) },
    delivery: { min: Math.min(...deliveries), max: Math.max(...deliveries) },
    returns: { min: Math.min(...returnDays), max: Math.max(...returnDays) },
    reliability: { min: Math.min(...reliabilities), max: Math.max(...reliabilities) },
    rating: { min: Math.min(...ratings), max: Math.max(...ratings) },
    relevance: { min: Math.min(...relevances), max: Math.max(...relevances) },
  };

  const scored = candidates.map((candidate, index) => {
    const price = candidate.variant.priceMinor;
    const stock = Math.min(candidate.variant.availableQuantity, 10);
    const delivery = candidate.policies.standardDeliveryDays;
    const returnWindow = candidate.policies.returnsAccepted ? candidate.policies.returnWindowDays : 0;

    // With a stated budget, price is scored on remaining headroom, so "well
    // under budget" beats "only just affordable" even in a tight field.
    const priceNormalized =
      options.budgetMinor && options.budgetMinor > 0
        ? Math.max(0, Math.min(1, (options.budgetMinor - price) / options.budgetMinor)) * 0.5 +
          normalise(price, bounds.price.min, bounds.price.max, false) * 0.5
        : normalise(price, bounds.price.min, bounds.price.max, false);

    const parts: Array<[keyof Weights, Criterion]> = [
      ["relevance", {
        name: "relevance",
        weight: weights.relevance,
        value: round(candidate.retrieval.rrf, 5),
        normalized: round(normalise(candidate.retrieval.rrf, bounds.relevance.min, bounds.relevance.max, true)),
        contribution: 0,
        note: "how closely the product matches the request, semantically and lexically",
      }],
      ["price", {
        name: "price",
        weight: weights.price,
        value: price,
        normalized: round(priceNormalized),
        contribution: 0,
        note: options.budgetMinor ? `scored against a ${formatMoney(options.budgetMinor)} budget` : "scored against the other options found",
      }],
      ["availability", {
        name: "availability",
        weight: weights.availability,
        value: candidate.variant.availableQuantity,
        normalized: round(normalise(stock, bounds.stock.min, bounds.stock.max, true)),
        contribution: 0,
        note: "units in stock right now",
      }],
      ["delivery", {
        name: "delivery",
        weight: weights.delivery,
        value: delivery,
        normalized: round(normalise(delivery, bounds.delivery.min, bounds.delivery.max, false)),
        contribution: 0,
        note: "standard delivery time in days",
      }],
      ["returns", {
        name: "returns",
        weight: weights.returns,
        value: returnWindow,
        normalized: round(normalise(returnWindow, bounds.returns.min, bounds.returns.max, true)),
        contribution: 0,
        note: "return window in days",
      }],
      ["reliability", {
        name: "reliability",
        weight: weights.reliability,
        value: candidate.merchant.fulfillmentRateBp,
        normalized: round(normalise(candidate.merchant.fulfillmentRateBp, bounds.reliability.min, bounds.reliability.max, true)),
        contribution: 0,
        note: "merchant order fulfilment rate",
      }],
      ["rating", {
        name: "rating",
        weight: weights.rating,
        // Reported value is the real customer rating; the score behind it is
        // confidence-adjusted so review volume counts.
        value: candidate.ratingBp ?? 0,
        normalized: round(
          normalise(adjustedRatings[index], bounds.rating.min, bounds.rating.max, true),
        ),
        contribution: 0,
        note: candidate.ratingCount
          ? `${((candidate.ratingBp ?? 0) / 1000).toFixed(1)}/5 from ${candidate.ratingCount} reviews` +
            (candidate.ratingCount < RATING_CONFIDENCE_REVIEWS
              ? ` (few reviews, so weighted toward the ${(priorBp / 1000).toFixed(1)} average)`
              : "")
          : "no customer reviews yet",
      }],
    ];

    const criteria = parts.map(([key, criterion]) => ({
      ...criterion,
      contribution: round(weights[key] * criterion.normalized),
    }));

    return {
      candidate,
      criteria,
      score: round(criteria.reduce((sum, c) => sum + c.contribution, 0)),
    };
  });

  scored.sort((a, b) => b.score - a.score || a.candidate.variant.priceMinor - b.candidate.variant.priceMinor);

  const limit = options.limit ?? scored.length;
  const ranked: RankedCandidate[] = scored.slice(0, limit).map((s, i) => ({ rank: i + 1, ...s }));

  const losers = scored.slice(limit).map<RejectedAlternative>((s) => ({
    ref: s.candidate.productId,
    label: `${s.candidate.title} — ${s.candidate.merchant.name}`,
    reason: "Scored below the options shown.",
    score: s.score,
  }));

  return {
    ranked,
    weights,
    priority,
    rejectedAlternatives: [...toRejectedAlternatives(options.rejected ?? []), ...losers],
  };
}

function toRejectedAlternatives(rejected: Rejected[]): RejectedAlternative[] {
  return rejected.map((r) => ({
    ref: r.productId,
    label: `${r.title} — ${r.merchantName}`,
    reason: r.detail,
  }));
}

/**
 * Concrete, factual differences between the winner and a runner-up.
 *
 * Computed from the scores, not narrated by a model — the LLM only turns these
 * into prose, so it cannot claim a difference that does not exist.
 */
export function compareToWinner(
  winner: RankedCandidate,
  other: RankedCandidate,
): { summary: string; deltas: string[] } {
  const deltas: string[] = [];

  const priceDiff = other.candidate.variant.priceMinor - winner.candidate.variant.priceMinor;
  if (priceDiff !== 0) {
    deltas.push(
      priceDiff > 0
        ? `${formatMoney(priceDiff)} more expensive`
        : `${formatMoney(-priceDiff)} cheaper`,
    );
  }

  const deliveryDiff = other.candidate.policies.standardDeliveryDays - winner.candidate.policies.standardDeliveryDays;
  if (deliveryDiff !== 0) {
    deltas.push(
      deliveryDiff > 0
        ? `${plural(deliveryDiff, "day")} slower to arrive`
        : `${plural(-deliveryDiff, "day")} faster to arrive`,
    );
  }

  const returnDiff = other.candidate.policies.returnWindowDays - winner.candidate.policies.returnWindowDays;
  if (returnDiff !== 0) {
    deltas.push(
      returnDiff > 0
        ? `${plural(returnDiff, "more day")} to return`
        : `${plural(-returnDiff, "fewer day")} to return`,
    );
  }

  if (other.candidate.variant.availableQuantity < 5) {
    deltas.push(`only ${other.candidate.variant.availableQuantity} left in stock`);
  }

  const gap = round(winner.score - other.score, 3);
  return {
    summary: `Scored ${gap} lower overall (${other.score} vs ${winner.score}).`,
    deltas,
  };
}
