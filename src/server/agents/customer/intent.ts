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
- Set "clarificationNeeded" only if the request names no product at all.

Reply with a single JSON object and nothing else:
{"productQuery":string,"category":string|null,"brand":string|null,"attributes":object,"priceMaxMinor":number|null,"priceMinMinor":number|null,"quantity":number,"priority":string,"currency":"INR","requireInStock":boolean,"clarificationNeeded":string|null}`;
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

  const { value, meta } = await completeJson(
    {
      task: "parse_intent",
      system: systemPrompt(vocabulary),
      messages: [{ role: "user", content: message }],
      temperature: 0,
      maxTokens: 900,
      reasoningEffort: "low",
      fallback: () => JSON.stringify(rulesResult()),
    },
    (raw) => shoppingIntentSchema.parse(raw),
  );

  // Rules recover anything the model dropped: a model that misses "size 10"
  // would otherwise silently widen the search.
  const rules = rulesResult();
  const intent: ShoppingIntent = {
    ...value,
    attributes: { ...rules.attributes, ...value.attributes },
    priceMaxMinor: value.priceMaxMinor ?? rules.priceMaxMinor,
    priceMinMinor: value.priceMinMinor ?? rules.priceMinMinor,
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
    excludeMerchantIds: options.excludeMerchantIds,
    limit: options.limit ?? 10,
  };
}
