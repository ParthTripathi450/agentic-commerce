import { formatMoney } from "@/lib/money";
import { hybridSearch, type SearchResult, type StructuredQuery } from "@/server/catalog/search";
import { record, recordAndAdvance, startSession } from "@/server/audit/recorder";
import { explainSelection, type Explanation } from "./explain";
import { intentToQuery, parseIntent } from "./intent";
import type { ShoppingIntent } from "./intent-schema";
import { rankCandidates, type RankingResult } from "./ranker";

/**
 * The customer shopping agent: UNDERSTAND → SEARCH → RANK → EXPLAIN.
 *
 * A state machine, not a free-form tool loop. Each state has one job and one
 * audited outcome, so a turn costs a bounded two LLM calls, cannot spiral, and
 * leaves a replayable trail. The purchase states (SELECT → CART → AUTHORIZE →
 * PAY → CONFIRM) continue this machine and are gated on explicit consent.
 */

export type Relaxation = {
  constraint: string;
  from: string;
  to: string;
  reason: string;
};

export type ShoppingTurn = {
  sessionId: string;
  intent: ShoppingIntent;
  ranking: RankingResult;
  explanation: Explanation | null;
  stats: SearchResult["stats"];
  /** Constraints the agent loosened, and what it loosened them to. */
  relaxations: Relaxation[];
  outcome: "results" | "no_results" | "needs_clarification";
  /** Message shown to the shopper when there is nothing to rank. */
  message: string | null;
  /** True when answers came from deterministic rules, not a model. */
  degraded: boolean;
};

/**
 * Progressive constraint relaxation.
 *
 * Ordered by how safe each is to loosen. Size is never relaxed — a shoe that
 * does not fit is not a result — while an inferred category is the first thing
 * to question, since the shopper never stated it explicitly.
 */
const RELAXATIONS: Array<{
  constraint: string;
  apply: (query: StructuredQuery, intent: ShoppingIntent) => { query: StructuredQuery; relaxation: Relaxation } | null;
}> = [
  {
    constraint: "category",
    apply: (query) => {
      if (!query.category) return null;
      return {
        query: { ...query, category: null },
        relaxation: {
          constraint: "category",
          from: query.category,
          to: "any category",
          reason: "the category was inferred from your wording, so I looked wider",
        },
      };
    },
  },
  {
    constraint: "budget",
    apply: (query) => {
      if (!query.priceMaxMinor) return null;
      const widened = Math.round(query.priceMaxMinor * 1.25);
      return {
        query: { ...query, priceMaxMinor: widened },
        relaxation: {
          constraint: "budget",
          from: formatMoney(query.priceMaxMinor),
          to: formatMoney(widened),
          reason: "nothing matched inside your budget, so I looked 25% above it",
        },
      };
    },
  },
  {
    constraint: "attributes",
    apply: (query) => {
      const attrs = { ...(query.attributes ?? {}) };
      // Size is physical: never relaxed. Everything else is a preference.
      const droppable = Object.keys(attrs).filter((k) => k !== "size");
      if (droppable.length === 0) return null;
      for (const key of droppable) delete attrs[key];
      return {
        query: { ...query, attributes: attrs },
        relaxation: {
          constraint: droppable.join(", "),
          from: droppable.map((k) => `${k} ${query.attributes?.[k]}`).join(", "),
          to: "any",
          reason: "no exact match, so I set aside your colour/style preference but kept the size",
        },
      };
    },
  },
  {
    constraint: "stock",
    apply: (query) => {
      if (query.requireInStock === false) return null;
      return {
        query: { ...query, requireInStock: false },
        relaxation: {
          constraint: "availability",
          from: "in stock only",
          to: "including out-of-stock",
          reason: "everything matching is currently out of stock, so I am showing it anyway",
        },
      };
    },
  },
];

export async function runShoppingTurn(input: {
  userId: string;
  message: string;
  sessionId?: string;
  excludeMerchantIds?: string[];
  limit?: number;
}): Promise<ShoppingTurn> {
  const sessionId =
    input.sessionId ??
    (await startSession({
      userId: input.userId,
      kind: "customer",
      title: input.message.slice(0, 200),
    })).id;

  // ---------------------------------------------------------- UNDERSTAND
  const understandStartedAt = Date.now();
  const { intent, meta: intentMeta, degraded } = await parseIntent(input.message);

  await recordAndAdvance(
    sessionId,
    {
      step: "UNDERSTAND",
      observation: {
        summary: `Shopper asked: "${input.message}"`,
        inputs: { message: input.message },
      },
      reasoning: {
        summary: "Mapped the request onto the catalog's real vocabulary.",
        narrative: describeIntent(intent),
      },
      action: { type: "parse_intent", params: { intent } },
      outcome: {
        status: "ok",
        latencyMs: Date.now() - understandStartedAt,
        model: intentMeta.model,
        provider: intentMeta.provider,
        tokensIn: intentMeta.tokensIn,
        tokensOut: intentMeta.tokensOut,
        detail: degraded ? "No LLM reachable; parsed with deterministic rules." : undefined,
      },
    },
    { intent },
  );

  if (intent.clarificationNeeded) {
    await record(sessionId, {
      step: "SEARCH",
      observation: { summary: "Search skipped — the request named no product." },
      reasoning: { summary: intent.clarificationNeeded },
      action: { type: "request_clarification" },
      outcome: { status: "blocked", detail: intent.clarificationNeeded },
    });
    return {
      sessionId,
      intent,
      ranking: { ranked: [], weights: {} as never, priority: intent.priority, rejectedAlternatives: [] },
      explanation: null,
      stats: { recalled: 0, considered: 0, accepted: 0, merchantsSearched: 0, durationMs: 0, topRelevance: 0 },
      relaxations: [],
      outcome: "needs_clarification",
      message: intent.clarificationNeeded,
      degraded,
    };
  }

  // --------------------------------------------------------------- SEARCH
  const searchStartedAt = Date.now();
  let query = intentToQuery(intent, {
    excludeMerchantIds: input.excludeMerchantIds,
    limit: input.limit ?? 10,
  });
  let search = await hybridSearch(query);
  const relaxations: Relaxation[] = [];

  // Nothing matched: loosen one constraint at a time and say what changed.
  //
  // Except when the catalogue simply does not stock this kind of thing —
  // relaxing then just surfaces unrelated products, which is exactly the
  // hallucination this guard exists to prevent.
  for (const strategy of search.noRelevantMatch ? [] : RELAXATIONS) {
    if (search.candidates.length > 0) break;
    const attempt = strategy.apply(query, intent);
    if (!attempt) continue;
    query = attempt.query;
    relaxations.push(attempt.relaxation);
    search = await hybridSearch(query);
  }

  await recordAndAdvance(
    sessionId,
    {
      step: "SEARCH",
      observation: {
        summary:
          `Searched ${search.stats.merchantsSearched} merchants' catalogs; ` +
          `${search.stats.recalled} products recalled, ${search.stats.accepted} met every constraint.`,
        inputs: { query },
        sources: ["pgvector semantic recall", "postgres full-text recall", "live inventory"],
        candidatesConsidered: search.stats.considered,
      },
      reasoning: {
        summary: relaxations.length
          ? `No exact match, so ${relaxations.length} constraint(s) were relaxed.`
          : "All stated constraints were satisfiable as given.",
        rejectedAlternatives: search.rejected.slice(0, 10).map((r) => ({
          ref: r.productId,
          label: `${r.title} — ${r.merchantName}`,
          reason: r.detail,
        })),
        tradeoffs: relaxations.map((r) => `${r.constraint}: ${r.from} → ${r.to} (${r.reason})`).join("; ") || undefined,
      },
      action: { type: "hybrid_search", params: { relaxations } },
      outcome: { status: "ok", latencyMs: Date.now() - searchStartedAt },
    },
    { searchStats: search.stats },
  );

  if (search.candidates.length === 0) {
    const message = buildNoResultsMessage(intent, search);
    await record(sessionId, {
      step: "RANK",
      observation: { summary: "Nothing to rank — no product satisfied the request." },
      reasoning: {
        summary: "Every candidate failed at least one hard constraint.",
        rejectedAlternatives: search.rejected.slice(0, 10).map((r) => ({
          ref: r.productId,
          label: `${r.title} — ${r.merchantName}`,
          reason: r.detail,
        })),
      },
      action: { type: "no_results" },
      outcome: { status: "blocked", detail: message },
    });
    return {
      sessionId,
      intent,
      ranking: { ranked: [], weights: {} as never, priority: intent.priority, rejectedAlternatives: [] },
      explanation: null,
      stats: search.stats,
      relaxations,
      outcome: "no_results",
      message,
      degraded,
    };
  }

  // ----------------------------------------------------------------- RANK
  const rankStartedAt = Date.now();
  const ranking = rankCandidates(search.candidates, {
    priority: intent.priority,
    budgetMinor: intent.priceMaxMinor,
    rejected: search.rejected,
    limit: input.limit ?? 5,
  });

  await recordAndAdvance(
    sessionId,
    {
      step: "RANK",
      observation: {
        summary: `Scored ${search.candidates.length} qualifying products on 7 weighted criteria.`,
        candidatesConsidered: search.candidates.length,
      },
      reasoning: {
        summary: `Ranked for "${ranking.priority}" priority. Winner: ${ranking.ranked[0].candidate.title} (${ranking.ranked[0].score}).`,
        criteria: ranking.ranked[0].criteria,
        rejectedAlternatives: ranking.rejectedAlternatives.slice(0, 10),
        tradeoffs: describeWeights(ranking),
      },
      action: { type: "rank_candidates", params: { weights: ranking.weights, priority: ranking.priority } },
      outcome: { status: "ok", latencyMs: Date.now() - rankStartedAt },
    },
    { topProductId: ranking.ranked[0].candidate.productId },
  );

  // -------------------------------------------------------------- EXPLAIN
  const explainStartedAt = Date.now();
  const explanation = await explainSelection({
    intent,
    ranked: ranking.ranked,
    weights: ranking.weights,
    excluded: ranking.rejectedAlternatives,
  });

  await recordAndAdvance(sessionId, {
    step: "EXPLAIN",
    observation: {
      summary: "Turned the score vector into an explanation for the shopper.",
      inputs: { topFactors: explanation.topFactors },
    },
    reasoning: {
      summary: "Narrative is generated from the computed criteria only — no catalog access.",
      narrative: explanation.narrative,
      criteria: explanation.topFactors,
    },
    action: { type: "explain_selection" },
    outcome: {
      status: "ok",
      latencyMs: Date.now() - explainStartedAt,
      model: explanation.meta.model,
      provider: explanation.meta.provider,
      tokensIn: explanation.meta.tokensIn,
      tokensOut: explanation.meta.tokensOut,
      detail: explanation.meta.degraded ? "Generated from a deterministic template." : undefined,
    },
  });

  return {
    sessionId,
    intent,
    ranking,
    explanation,
    stats: search.stats,
    relaxations,
    outcome: "results",
    message: null,
    degraded: degraded || explanation.meta.degraded,
  };
}

function describeIntent(intent: ShoppingIntent): string {
  const bits = [`looking for "${intent.productQuery}"`];
  if (intent.category) bits.push(`in ${intent.category}`);
  for (const [k, v] of Object.entries(intent.attributes)) bits.push(`${k} ${v}`);
  if (intent.priceMaxMinor) bits.push(`under ${formatMoney(intent.priceMaxMinor)}`);
  if (intent.quantity > 1) bits.push(`quantity ${intent.quantity}`);
  bits.push(`priority: ${intent.priority}`);
  return bits.join(", ");
}

function describeWeights(ranking: RankingResult): string {
  return Object.entries(ranking.weights)
    .sort(([, a], [, b]) => b - a)
    .map(([name, weight]) => `${name} ${weight}`)
    .join(", ");
}

/** Explains an empty result set in terms of what actually blocked each option. */
function buildNoResultsMessage(intent: ShoppingIntent, search: SearchResult): string {
  // The catalogue does not stock this at all — say so plainly rather than
  // implying the shopper's filters were too tight.
  if (search.noRelevantMatch) {
    return `No merchant on this marketplace sells anything like "${intent.productQuery}". I have not shown you alternatives, because none of them are what you asked for.`;
  }

  const reasons = new Map<string, number>();
  for (const r of search.rejected) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);

  const dominant = [...reasons.entries()].sort(([, a], [, b]) => b - a)[0];
  const base = `I could not find anything matching "${intent.productQuery}"`;
  const constraints: string[] = [];
  for (const [k, v] of Object.entries(intent.attributes)) constraints.push(`${k} ${v}`);
  if (intent.priceMaxMinor) constraints.push(`under ${formatMoney(intent.priceMaxMinor)}`);
  const withConstraints = constraints.length ? `${base} with ${constraints.join(", ")}` : base;

  if (!dominant) return `${withConstraints}. Nothing in the catalog came close enough to consider.`;

  const explanation: Record<string, string> = {
    out_of_stock: "everything that matched is out of stock right now",
    over_budget: "the matching products all cost more than your budget",
    attribute_mismatch: "no merchant stocks that exact combination",
    category_mismatch: "the closest products are in a different category",
    outside_sale_window: "the matching products are not on sale at the moment",
    merchant_excluded: "the only matches are from merchants you excluded",
    brand_mismatch: "no matching products from that brand",
    under_budget: "the matching products cost less than your stated minimum",
  };

  return `${withConstraints} — ${explanation[dominant[0]] ?? "every option failed one of your constraints"}. Try widening the budget or the options.`;
}
