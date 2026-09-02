import { formatMoney } from "@/lib/money";
import { hybridSearch, type SearchResult, type StructuredQuery } from "@/server/catalog/search";
import { record, recordAndAdvance, startSession } from "@/server/audit/recorder";
import { describeKnown, type SlotId } from "./clarify";
import {
  intentFromUnderstanding,
  understandConversation,
  type ConversationTurn,
} from "./conversation";
import { parseIntentWithRules } from "./intent-rules";
import { getVocabulary } from "@/server/catalog/vocabulary";
import { explainSelection, type Explanation } from "./explain";
import { intentToQuery } from "./intent";
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
  outcome: "results" | "no_results" | "needs_clarification" | "asking";
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
  if (!input.skipQuestions && !understanding.readyToSearch && understanding.question) {
    await record(sessionId, {
      step: "SEARCH",
      observation: {
        summary: `Search deferred — asking about ${understanding.questionAbout ?? "a missing detail"}.`,
        inputs: { slots: understanding.slots },
      },
      reasoning: {
        summary: understanding.understanding || "Not enough understood to rank honestly yet.",
      },
      action: { type: "ask_question", params: { about: understanding.questionAbout } },
      outcome: { status: "blocked", detail: understanding.question },
    });

    return {
      sessionId,
      intent,
      ranking: { ranked: [], weights: {} as never, priority: intent.priority, rejectedAlternatives: [] },
      explanation: null,
      stats: { recalled: 0, considered: 0, accepted: 0, merchantsSearched: 0, durationMs: 0, topRelevance: 0 },
      relaxations: [],
      outcome: "asking",
      message: understanding.question,
      question: {
        id: understanding.questionAbout ?? `turn-${answered.length}`,
        question: understanding.question,
        rationale: understanding.understanding,
        skippable: true,
        options: understanding.suggestions.map((label) => ({ label, value: label })),
      },
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
