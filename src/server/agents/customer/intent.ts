import { completeJson, type LlmResult } from "@/server/ai/llm";
import { getVocabulary, type Vocabulary } from "@/server/catalog/vocabulary";
import type { StructuredQuery } from "@/server/catalog/search";
import { parseIntentWithRules } from "./intent-rules";
import { shoppingIntentSchema, type ShoppingIntent } from "./intent-schema";

/**
 * UNDERSTAND: natural language → structured, validated intent.
 *
 * This is one of only two LLM calls in a shopping turn. The model is given the
 * catalog's real vocabulary and asked purely to map words onto it — it never
 * sees the catalog itself and never decides what to buy.
 */

function systemPrompt(vocabulary: Vocabulary): string {
  const axes = Object.entries(vocabulary.axes)
    .map(([axis, values]) => `  ${axis}: ${values.slice(0, 40).join(", ")}`)
    .join("\n");

  return `You convert a shopper's message into a structured search intent for a multi-merchant marketplace.

Only use values from this catalog vocabulary. If the shopper asks for something outside it, leave the field null rather than inventing a value.

Categories:
  ${vocabulary.categories.join(", ")}
Brands:
  ${vocabulary.brands.join(", ")}
Variant axes:
${axes}

Rules:
- Money is in Indian Rupees. Return price fields in PAISE (minor units): "under ₹5,000" is 500000.
- "productQuery" is the shopper's description of the item WITHOUT price or size constraints — it is used for semantic search.
- "attributes" holds only exact variant-axis values from the list above (e.g. {"color":"black","size":"10"}).
- "priority" is how to WEIGH options against each other. It is NOT the same as a constraint.
  A price limit ("under X", "below X", "budget of X") is a CONSTRAINT: set priceMaxMinor and leave priority "balanced".
  Use a non-balanced priority ONLY when the shopper explicitly emphasises one dimension:
    "cheapest", "as cheap as possible", "lowest price"   -> cheapest
    "fastest", "need it tomorrow", "urgent"              -> fastest
    "best", "highest rated", "most reliable"             -> best_quality
    "easy returns", "flexible", "exchangeable"           -> most_flexible
  Worked examples:
    "black shoes under 5000"          -> priceMaxMinor 500000, priority "balanced"
    "the cheapest black shoes"        -> priceMaxMinor null,   priority "cheapest"
    "cheapest black shoes under 5000" -> priceMaxMinor 500000, priority "cheapest"
- "quantity": the number requested. Use 0 if they did not say — never invent one.
- Set "quantityStated" true ONLY if the shopper gave an actual number ("2 pairs", "three units").
- Set "clarificationNeeded" when the request names no product at all, OR when the shopper
  implies more than one without saying how many ("a few", "some", "for my team"). Ask how many.
  Do NOT quietly assume 1 in that case — that is a guess presented as an answer.
  A plain singular request ("a yoga mat", "black running shoes") needs no clarification: 1 is correct.

Reply with a single JSON object and nothing else:
{"productQuery":string,"category":string|null,"brand":string|null,"attributes":object,"priceMaxMinor":number|null,"priceMinMinor":number|null,"quantity":number,"quantityStated":boolean,"priority":string,"currency":"INR","requireInStock":boolean,"clarificationNeeded":string|null}`;
}

export type ParsedIntent = {
  intent: ShoppingIntent;
  meta: LlmResult;
  /** True when rules produced the intent because no model was reachable. */
  degraded: boolean;
};

export async function parseIntent(message: string): Promise<ParsedIntent> {
  const vocabulary = await getVocabulary();
  const rulesResult = () => parseIntentWithRules(message, vocabulary);

  /*
   * The only LLM path here that had no deterministic fallback (§8.13).
   *
   * `fallback` covers a provider being unreachable, but not the model
   * answering with something unparseable — and that threw out of the route as
   * a 500, which the shopper saw as "could not reach the agent" rather than a
   * degraded but working search. Rules answer this well enough to proceed.
   *
   * `maxTokens: 900` is also below the >= 1200 that reasoning models need
   * (§8.7): they spend the budget thinking and return a truncated object,
   * which is exactly the failure this now survives.
   */
  let value: ShoppingIntent;
  let meta: Awaited<ReturnType<typeof completeJson<ShoppingIntent>>>["meta"];

  try {
    ({ value, meta } = await completeJson(
      {
        task: "parse_intent",
        system: systemPrompt(vocabulary),
        messages: [{ role: "user", content: message }],
        temperature: 0,
        maxTokens: 1400,
        reasoningEffort: "low",
        fallback: () => JSON.stringify(rulesResult()),
      },
      (raw) => shoppingIntentSchema.parse(raw),
    ));
  } catch {
    value = rulesResult();
    meta = {
      text: "",
      provider: "deterministic-fallback",
      model: "rule-based",
      latencyMs: 0,
      degraded: true,
      attempts: [],
    };
  }

  // Rules recover anything the model dropped: a model that misses "size 10"
  // would otherwise silently widen the search.
  const rules = rulesResult();
  const intent: ShoppingIntent = {
    ...value,
    attributes: { ...rules.attributes, ...value.attributes },
    priceMaxMinor: value.priceMaxMinor ?? rules.priceMaxMinor,
    priceMinMinor: value.priceMinMinor ?? rules.priceMinMinor,
    /*
     * Category comes from the RULES, not the model.
     *
     * The rules only set it when a real category name appears in the message,
     * so it is a fact rather than an inference. The model guessed "Activewear"
     * for "yoga mat" — mats live in Fitness Accessories — and because category
     * is a hard filter, that guess removed every yoga mat and surfaced
     * t-shirts instead. Semantic search already handles category implicitly;
     * it only needs to be enforced when the shopper actually named one.
     */
    category: rules.category,
    /*
     * Availability, like category, is decided by the rules rather than the
     * model. gpt-oss intermittently returned requireInStock:false for a plain
     * request, which silently widens the search to products nobody can buy.
     */
    requireInStock: rules.requireInStock,
    /*
     * Clarification is rule-owned too, and for the same reason as category.
     *
     * The model was answering "I want shoes" with "How many shoes do you
     * need?" — a pair is obviously one, and that question hijacked the turn
     * before the slot-filling in `clarify.ts` could ask something useful.
     * The model's own wording is kept ONLY when the request names no product
     * at all, which is the one case rules cannot resolve; vagueness about
     * WHICH product is now handled by asking, not by blocking.
     */
    clarificationNeeded:
      rules.clarificationNeeded ??
      (value.productQuery.trim().length === 0 ? value.clarificationNeeded : null),
    quantityStated: (value.quantityStated || rules.quantityStated) && value.quantity !== 0,
    // 0 means "unstated"; searching still needs a concrete number.
    quantity: value.quantity === 0 ? 1 : value.quantity,
    qualityConstraints: [],
  };

  return { intent, meta, degraded: meta.degraded };
}

/** Projects a validated intent onto the retrieval layer's query shape. */
export function intentToQuery(
  intent: ShoppingIntent,
  options: { excludeMerchantIds?: string[]; limit?: number } = {},
): StructuredQuery {
  return {
    text: intent.productQuery,
    category: intent.category,
    brand: intent.brand,
    attributes: intent.attributes,
    priceMinMinor: intent.priceMinMinor,
    priceMaxMinor: intent.priceMaxMinor,
    requireInStock: intent.requireInStock,
    qualityConstraints: intent.qualityConstraints,
    excludeMerchantIds: options.excludeMerchantIds,
    limit: options.limit ?? 10,
  };
}
