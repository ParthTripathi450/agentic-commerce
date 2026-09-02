import { formatMoney } from "@/lib/money";
import { hybridSearch, type SearchResult, type StructuredQuery } from "@/server/catalog/search";
import { record, recordAndAdvance, startSession } from "@/server/audit/recorder";
import { findAlternatives, type Alternative } from "./alternatives";
import { computeFacets, type PriceBucket } from "@/server/catalog/facets";
import { describeKnown, optionsForSlot, type SlotId } from "./clarify";
import {
  intentFromUnderstanding,
  understandConversation,
  type ConversationTurn,
} from "./conversation";
import { parseIntentWithRules } from "./intent-rules";
import { getVocabulary } from "@/server/catalog/vocabulary";
import { explainSelection, type Explanation } from "./explain";
import { intentToQuery } from "./intent";
import { MAX_TURNS } from "./conversation";
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
  outcome: "results" | "no_results" | "needs_clarification" | "asking" | "alternatives";
  /** Message shown to the shopper when there is nothing to rank. */
  message: string | null;
  /**
   * The question the agent wants answered before it searches.
   *
   * Present only when `outcome === "asking"`. Written by the model from the
   * whole transcript — see `conversation.ts`. `options` are tappable answers,
   * grounded against the live catalogue so tapping one always leads somewhere.
   */
  question: {
    id: string;
    question: string;
    rationale: string;
    skippable: boolean;
    options: { label: string; value: string }[];
  } | null;
  /**
   * Buyable near-misses when the exact request could not be filled.
   *
   * Populated only when the catalogue stocks this KIND of thing — never when
   * `noRelevantMatch` fired. Each carries how it differs from the request.
   */
  alternatives: Alternative[];
  /** Constraints set aside to find those alternatives. */
  alternativesDropped: string[];
  /** Slots answered so far, so the next turn does not repeat itself. */
  answered: SlotId[];
  /** What the agent currently believes, so the shopper can correct it. */
  known: string[];
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
  /** Slots the shopper has already answered in this conversation. */
  answered?: SlotId[];
  /**
   * The conversation so far, oldest first, excluding the current message.
   *
   * The model reads all of it, which is what lets a later reply reinterpret an
   * earlier one ("actually make that wide fit") instead of only appending.
   */
  history?: ConversationTurn[];
  /** Set when the shopper explicitly asked to stop being questioned. */
  skipQuestions?: boolean;
}): Promise<ShoppingTurn> {
  const sessionId =
    input.sessionId ??
    (await startSession({
      userId: input.userId,
      kind: "customer",
      title: input.message.slice(0, 200),
    })).id;

  const answered = input.answered ?? [];

  // ---------------------------------------------------------- UNDERSTAND
  const understandStartedAt = Date.now();
  /*
   * ONE understanding call per turn.
   *
   * `parseIntent` is no longer called on the happy path — the conversation
   * model already extracts everything it produced, and a second call per turn
   * doubled the rate-limit pressure on a free tier for no extra information.
   * It survives only as the deterministic fallback source below.
   */
  const turns: ConversationTurn[] = [
    ...(input.history ?? []),
    { role: "shopper", content: input.message },
  ];
  const shopperText = turns
    .filter((t) => t.role === "shopper")
    .map((t) => t.content)
    .join(", ");

  /*
   * The fallback intent is parsed by the RULES, not left empty.
   *
   * It is only used when no LLM is reachable, but it must still be as capable
   * as the old deterministic path: an empty shell made the fallback think
   * nothing was known, so a fully specified request ("black running shoes, size
   * 10, under ₹5,000") got interrogated instead of searched.
   */
  const understanding = await understandConversation({
    turns,
    askedSlots: answered,
    fallbackIntent: parseIntentWithRules(shopperText || input.message, await getVocabulary()),
  });

  const intent = intentFromUnderstanding(understanding, shopperText);
  const degraded = understanding.degraded;
  const intentMeta = understanding.meta;

  await recordAndAdvance(
    sessionId,
    {
      step: "UNDERSTAND",
      observation: {
        summary: `Shopper asked: "${input.message}"`,
        inputs: { message: input.message },
      },
      reasoning: {
        summary: understanding.understanding || "Understood the request from the conversation.",
        narrative: describeIntent(intent),
      },
      action: { type: "understand_conversation", params: { slots: understanding.slots } },
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
      question: null,
      alternatives: [],
      alternativesDropped: [],
      answered,
      known: describeKnown(intent),
      degraded,
    };
  }

  // ------------------------------------------------------------------ ASK
  //
  // The model already read the whole conversation above. If it still does not
  // know enough to rank honestly, it asks — in its own words, about whatever it
  // judged most useful. No keyword matching on the reply: "something for
  // pounding pavement" and "road running" land in the same place because it
  // understood them, not because either matched a pattern.
  //
  // What stays ours: the question CEILING (in `conversation.ts`), and the rule
  // that an unstated slot comes back null rather than guessed.
  /*
   * Budget is always worth asking, and is asked LAST.
   *
   * A price band is the single most useful thing a shopper can tap: it needs no
   * typing and it halves the result set. The model often skips it, so the rule
   * adds it back rather than leaving it to chance — but only once everything
   * else is known, so the bands can be computed from products they might
   * actually buy rather than from the whole catalogue.
   */
  const budgetUnknown =
    intent.priceMaxMinor === null &&
    intent.priceMinMinor === null &&
    !answered.includes("budget");

  const shouldAskBudget =
    !input.skipQuestions &&
    budgetUnknown &&
    understanding.readyToSearch &&
    answered.length < MAX_TURNS;

  /*
   * The model sometimes re-asks a topic it was told was covered. Repeating a
   * question is the fastest way to look broken, so the repeat is caught here
   * rather than trusted to the prompt: fall through to budget if that is still
   * unknown, otherwise stop asking and search.
   */
  const modelRepeatedItself =
    understanding.questionAbout !== null &&
    (answered as string[]).includes(understanding.questionAbout);

  const askAnything =
    !input.skipQuestions &&
    (shouldAskBudget ||
      (!understanding.readyToSearch &&
        understanding.question !== null &&
        (!modelRepeatedItself || budgetUnknown)));

  if (askAnything) {
    /*
     * Chips are computed from LIVE stock, not from a static list.
     *
     * A suggestion is a promise: tapping "Black" has to lead to black shoes
     * that can be bought today. The facet query runs over the products this
     * search actually recalled, so a colour nobody stocks is never offered and
     * a price band with nothing in it is never shown.
     */
    const facetQuery = intentToQuery(
      { ...intent, attributes: {}, priceMaxMinor: null, priceMinMinor: null },
      { excludeMerchantIds: input.excludeMerchantIds, limit: 60 },
    );
    const facetSearch = await hybridSearch(facetQuery);
    const facets = await computeFacets(facetSearch.candidates.map((c) => c.productId));

    /*
     * The model sometimes re-asks a topic it was told was covered. Repeating a
     * question is the fastest way to look broken, so the repeat is caught here
     * rather than trusted to the prompt: fall through to budget if that is
     * still unknown, otherwise stop asking and search.
     */
    const modelRepeatedItself =
      !shouldAskBudget &&
      understanding.questionAbout !== null &&
      (answered as string[]).includes(understanding.questionAbout);


    const askingAbout =
      shouldAskBudget || (modelRepeatedItself && budgetUnknown)
        ? "budget"
        : (understanding.questionAbout ?? "");
    const questionText = askingAbout === "budget"
      ? facets.priceRange
        ? `Last thing — what would you like to spend? These run from ${formatMoney(facets.priceRange.minMinor)} to ${formatMoney(facets.priceRange.maxMinor)}.`
        : "Last thing — what would you like to spend?"
      : understanding.question!;

    const options = buildOptions(askingAbout, facets, understanding.suggestions);

    await record(sessionId, {
      step: "SEARCH",
      observation: {
        summary: `Search deferred — asking about ${askingAbout || "a missing detail"}.`,
        inputs: { slots: understanding.slots, inStockVariants: facets.inStockVariants },
      },
      reasoning: {
        summary: understanding.understanding || "Not enough understood to rank honestly yet.",
        narrative: `Offering ${options.length} suggestions, all backed by live stock.`,
      },
      action: { type: "ask_question", params: { about: askingAbout } },
      outcome: { status: "blocked", detail: questionText },
    });

    return {
      sessionId,
      intent,
      ranking: { ranked: [], weights: {} as never, priority: intent.priority, rejectedAlternatives: [] },
      explanation: null,
      stats: { recalled: 0, considered: 0, accepted: 0, merchantsSearched: 0, durationMs: 0, topRelevance: 0 },
      relaxations: [],
      outcome: "asking",
      message: questionText,
      question: {
        id: askingAbout || `turn-${answered.length}`,
        question: questionText,
        rationale: understanding.understanding,
        skippable: true,
        options,
      },
      alternatives: [],
      alternativesDropped: [],
      answered,
      known: understandingSummary(understanding.slots),
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
    /*
     * Before giving up: is this "we don't sell that" or "we sell it, but not in
     * that colour"? The agent exists to sell, and the second case is a
     * recoverable sale — but only if the substitute is labelled as one.
     * `findAlternatives` refuses outright when `noRelevantMatch` fired.
     */
    const { alternatives, dropped } = await findAlternatives({
      intent,
      query,
      search,
      limit: 4,
    });

    if (alternatives.length > 0) {
      const message =
        `I could not find exactly that, so I set aside ${dropped.join(" and ")}. ` +
        `Here is the closest I can actually sell you today — each one says how it differs.`;

      await record(sessionId, {
        step: "RANK",
        observation: {
          summary: `Exact request unavailable; offering ${alternatives.length} buyable near-misses.`,
          inputs: { dropped },
        },
        reasoning: {
          summary:
            "The catalogue stocks this kind of product, so a substitute is useful rather than a guess.",
          tradeoffs: alternatives
            .map((a) => `${a.candidate.title}: ${a.differences.join("; ")}`)
            .join(" | "),
        },
        action: { type: "offer_alternatives" },
        outcome: { status: "ok", detail: message },
      });

      return {
        sessionId,
        intent,
        ranking: { ranked: [], weights: {} as never, priority: intent.priority, rejectedAlternatives: [] },
        explanation: null,
        stats: search.stats,
        relaxations,
        outcome: "alternatives",
        message,
        question: null,
        alternatives,
        alternativesDropped: dropped,
        answered,
        known: describeKnown(intent),
        degraded,
      };
    }

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
      question: null,
      alternatives: [],
      alternativesDropped: [],
      answered,
      known: describeKnown(intent),
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
    question: null,
    alternatives: [],
    alternativesDropped: [],
    answered,
    known: describeKnown(intent),
    degraded: degraded || explanation.meta.degraded,
  };
}

/**
 * What the agent believes, in the shopper's terms.
 *
 * Built from the understood slots rather than the parsed filters, so the
 * shopper sees what was heard and can correct it before anything is searched.
 */
/**
 * Tappable answers for one question, every one backed by live stock.
 *
 * Falls back to the model's own suggestions only for questions the catalogue
 * has no facet for (purpose, occasion) — those are ways of describing a need,
 * not attributes we can count rows of.
 */
function buildOptions(
  askingAbout: string,
  facets: { attributes: Record<string, { value: string; label: string; count: number }[]>; priceBuckets: PriceBucket[] },
  fromModel: string[],
): { label: string; value: string }[] {
  if (askingAbout === "budget") {
    return [
      ...facets.priceBuckets.map((b) => ({
        label: b.label,
        // Phrased as the shopper would say it, so it re-parses naturally.
        value:
          b.minMinor === null
            ? `under ${Math.round((b.maxMinor ?? 0) / 100)}`
            : b.maxMinor === null
              ? `over ${Math.round(b.minMinor / 100)}`
              : `between ${Math.round(b.minMinor / 100)} and ${Math.round(b.maxMinor / 100)}`,
      })),
      { label: "No limit", value: "no budget limit" },
    ];
  }

  const facet = facets.attributes[askingAbout];
  if (facet?.length) {
    return facet.map((v) => ({ label: v.label, value: v.value }));
  }

  if (fromModel.length > 0) return fromModel.map((label) => ({ label, value: label }));

  // Never render an empty chip row — it reads as a broken UI, and the whole
  // point is that the shopper does not have to type.
  return optionsForSlot(askingAbout);
}

function understandingSummary(slots: Record<string, unknown>): string[] {
  const labels: Record<string, string> = {
    productType: "", purpose: "", size: "size", color: "", brand: "",
    width: "", gender: "", budgetMax: "under ₹", budgetMin: "over ₹", quantity: "qty",
  };
  const out: string[] = [];
  for (const [key, value] of Object.entries(slots)) {
    if (value === null || value === undefined || value === "") continue;
    const prefix = labels[key] ?? "";
    out.push(prefix ? `${prefix}${prefix.endsWith("₹") ? "" : " "}${value}` : String(value));
  }
  return out;
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
