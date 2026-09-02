import type { Criterion, RejectedAlternative } from "@/lib/agent-types";
import { formatMoney } from "@/lib/money";
import { normalizeTypography } from "@/lib/text";
import { z } from "zod";
import { completeJson, type LlmResult } from "@/server/ai/llm";
import { compareToWinner, type RankedCandidate, type Weights } from "./ranker";
import type { ShoppingIntent } from "./intent-schema";

/**
 * EXPLAIN: turns the ranking's score vector into prose.
 *
 * The model receives ONLY the computed criteria, weights and factual deltas —
 * never the raw catalog — and is instructed to add no facts of its own. So the
 * stated reasons are always the reasons that actually produced the ranking, and
 * the deterministic template below says the same thing in plainer words when no
 * model is available.
 */

export type Comparison = {
  rank: number;
  productId: string;
  label: string;
  priceMinor: number;
  summary: string;
  deltas: string[];
};

export type Explanation = {
  /**
   * Why the top pick won, as short scannable points.
   *
   * Points rather than prose: a shopper comparing options reads a list, not a
   * paragraph. Each point is one fact from the score vector.
   */
  points: string[];
  /** Prose form, kept for the audit trail where the full reasoning matters. */
  narrative: string;
  /** The criteria that contributed most, strongest first. */
  topFactors: Criterion[];
  comparisons: Comparison[];
  excluded: RejectedAlternative[];
  meta: LlmResult;
};

/** Joins a list the way a person would: "a, b and c". */
function joinNaturally(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function topFactorsOf(criteria: Criterion[], count = 3): Criterion[] {
  return [...criteria].sort((a, b) => b.contribution - a.contribution).slice(0, count);
}

function describeCriterion(criterion: Criterion, candidate: RankedCandidate): string {
  switch (criterion.name) {
    case "price":
      return `it costs ${formatMoney(candidate.candidate.variant.priceMinor)}`;
    case "delivery":
      return `it arrives in about ${candidate.candidate.policies.standardDeliveryDays} days`;
    case "returns":
      return `it has a ${candidate.candidate.policies.returnWindowDays}-day return window`;
    case "availability":
      return `${candidate.candidate.variant.availableQuantity} units are in stock`;
    case "reliability":
      return `${candidate.candidate.merchant.name} fulfils ${(
        candidate.candidate.merchant.fulfillmentRateBp / 100
      ).toFixed(1)}% of orders`;
    case "rating":
      return candidate.candidate.ratingCount
        ? `it is rated ${((candidate.candidate.ratingBp ?? 0) / 1000).toFixed(1)}/5 from ${candidate.candidate.ratingCount} customer reviews`
        : "it has no customer reviews yet";
    case "relevance":
      return "it closely matches what you described";
    default:
      return criterion.name;
  }
}

/**
 * Deterministic points, used when no model is reachable — and as the shape the
 * model is asked to produce, so both paths read identically.
 */
export function templatePoints(
  intent: ShoppingIntent,
  ranked: RankedCandidate[],
  comparisons: Comparison[],
): string[] {
  const winner = ranked[0];
  const points: string[] = [];

  points.push(
    `${winner.candidate.title} at ${formatMoney(winner.candidate.variant.priceMinor)}` +
      (intent.priceMaxMinor
        ? ` — ${formatMoney(intent.priceMaxMinor - winner.candidate.variant.priceMinor)} under budget`
        : ` from ${winner.candidate.merchant.name}`),
  );

  for (const criterion of topFactorsOf(winner.criteria, 3)) {
    if (criterion.name === "price") continue; // already the opening point
    points.push(capitalise(describeCriterion(criterion, winner)));
  }

  if (comparisons.length > 0) {
    const runnerUp = comparisons[0];
    const deltas = runnerUp.deltas.slice(0, 2).join(" and ");
    if (deltas) points.push(`Beats ${runnerUp.label.split(" from ")[0]}, which is ${deltas}`);
  }

  const excluded = ranked.length > 0 ? null : null;
  void excluded;
  return points.slice(0, 5);
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Deterministic explanation used when no model is reachable. */
export function templateExplanation(
  intent: ShoppingIntent,
  ranked: RankedCandidate[],
  comparisons: Comparison[],
): string {
  const winner = ranked[0];
  const factors = topFactorsOf(winner.criteria)
    .map((c) => describeCriterion(c, winner))
    .join("|")
    .split("|");

  const constraintList: string[] = [];
  if (intent.priceMaxMinor) constraintList.push(`under ${formatMoney(intent.priceMaxMinor)}`);
  for (const [axis, value] of Object.entries(intent.attributes)) constraintList.push(`${axis} ${value}`);

  const lead =
    `I picked the ${winner.candidate.title} from ${winner.candidate.merchant.name} at ` +
    `${formatMoney(winner.candidate.variant.priceMinor)}` +
    (constraintList.length
      ? `, which meets your requirements: ${joinNaturally(constraintList)}.`
      : ".");

  const because = ` It ranked highest because ${joinNaturally(factors)}.`;

  const versus = comparisons.length
    ? ` Compared with ${comparisons[0].label}, that one is ${
        joinNaturally(comparisons[0].deltas.slice(0, 2)) || "close but scored lower"
      }.`
    : "";

  return lead + because + versus;
}

const pointsSchema = z.object({ points: z.array(z.string().max(160)).min(1).max(6) });

const SYSTEM = `You explain an automated shopping decision to the shopper who asked for it.

You are given the scoring that ALREADY decided the ranking. Turn it into a short, scannable list.

Strict rules:
- Use ONLY facts present in the JSON. Never add a product detail, feature, price or claim that is not there.
- Do not invent reasons. The criteria in the JSON are the actual reasons.
- "comparedToSelected" lists the real differences. Report them as given. Never describe a
  stated difference as "similar", "comparable" or "about the same", and never omit a
  difference to make the choice look better than it is.
- Reply with 3 to 5 points. Each point is ONE fact, at most 12 words, no trailing full stop.
- NEVER quote internal scores, weights or decimals like 0.9957 — they are meaningless to a
  shopper. Use the plain-language reasons in "strongestReasons" as they are written.
- The FIRST point must name the product and its price.
- Then the strongest reasons. Then how it beats the runner-up. If a strong-looking option was
  excluded, make that the last point.
- Plain language, second person ("you"). No markdown, no bullet characters — just the text.

Reply with JSON only: {"points":["...","..."]}`;

export async function explainSelection(options: {
  intent: ShoppingIntent;
  ranked: RankedCandidate[];
  weights: Weights;
  excluded: RejectedAlternative[];
}): Promise<Explanation> {
  const { intent, ranked, excluded } = options;
  const winner = ranked[0];

  const comparisons: Comparison[] = ranked.slice(1, 4).map((other) => {
    const diff = compareToWinner(winner, other);
    return {
      rank: other.rank,
      productId: other.candidate.productId,
      label: `${other.candidate.title} from ${other.candidate.merchant.name}`,
      priceMinor: other.candidate.variant.priceMinor,
      summary: diff.summary,
      deltas: diff.deltas,
    };
  });

  // Compact, fact-only payload. The model never sees the catalog.
  const decision = {
    shopperAsked: {
      for: intent.productQuery,
      constraints: {
        ...intent.attributes,
        maxPrice: intent.priceMaxMinor ? formatMoney(intent.priceMaxMinor) : null,
      },
      priority: intent.priority,
    },
    selected: {
      product: winner.candidate.title,
      merchant: winner.candidate.merchant.name,
      price: formatMoney(winner.candidate.variant.priceMinor),
      variant: winner.candidate.variant.attributes,
      inStock: winner.candidate.variant.availableQuantity,
      deliveryDays: winner.candidate.policies.standardDeliveryDays,
      returnWindowDays: winner.candidate.policies.returnWindowDays,
      // Deliberately NOT the normalised scores or weights: a shopper has no use
      // for "relevance 0.9957". They get the human-readable fact each score was
      // derived from. The numbers stay in the audit trail, where they belong.
      strongestReasons: topFactorsOf(winner.criteria).map((c) =>
        describeCriterion(c, winner),
      ),
    },
    runnersUp: comparisons.map((c) => ({
      product: c.label,
      price: formatMoney(c.priceMinor),
      comparedToSelected: c.deltas,
    })),
    excludedBeforeRanking: excluded.slice(0, 4).map((e) => ({
      product: e.label,
      reason: e.reason,
    })),
  };

  const fallbackPoints = templatePoints(intent, ranked, comparisons);

  let points = fallbackPoints;
  let meta: LlmResult;

  try {
    const result = await completeJson(
      {
        task: "explain_selection",
        system: SYSTEM,
        messages: [{ role: "user", content: JSON.stringify(decision, null, 2) }],
        temperature: 0.3,
        // Reasoning models spend tokens thinking before answering; too small a
        // budget yields an empty completion rather than a short one.
        maxTokens: 1200,
        reasoningEffort: "low",
        fallback: () => JSON.stringify({ points: fallbackPoints }),
      },
      (raw) => pointsSchema.parse(raw),
    );
    points = result.value.points
      .map((p) => capitalise(normalizeTypography(p).replace(/[.\s]+$/, "")))
      .filter(Boolean)
      .slice(0, 5);
    meta = result.meta;
  } catch {
    // Wording is a nicety; the computed points are the substance.
    points = fallbackPoints;
    meta = {
      text: "",
      provider: "deterministic-fallback",
      model: "rule-based",
      latencyMs: 0,
      degraded: true,
      attempts: [],
    };
  }

  if (points.length === 0) points = fallbackPoints.map(capitalise);

  return {
    points,
    narrative: points.join(". ") + ".",
    topFactors: topFactorsOf(winner.criteria),
    comparisons,
    excluded,
    meta,
  };
}
