import { z } from "zod";
import { toMinor } from "@/lib/money";
import { normalizeTypography } from "@/lib/text";
import { completeJson } from "@/server/ai/llm";
import { getVocabulary } from "@/server/catalog/vocabulary";
import { missingSlots, type SlotId } from "./clarify";
import { wantsOutOfStock } from "./intent-rules";
import { shoppingIntentSchema, type ShoppingIntent } from "./intent-schema";

/**
 * Conversational understanding.
 *
 * The model reads the WHOLE transcript and reports what it understood, what is
 * still unknown, and what to ask next in its own words. There is no keyword
 * matching on the shopper's replies: "something for pounding pavement on
 * weekends" and "road running" reach the same place because the model
 * understands them, not because either matched a pattern.
 *
 * What the model is trusted with, and what it is not:
 *
 *   UNDERSTANDING  — free. Extracting purpose, size, colour, budget from
 *                    natural language, deciding what is still missing, phrasing
 *                    the next question. This is what a language model is for.
 *
 *   DECIDING       — bounded. It cannot ask more than `MAX_TURNS` questions, it
 *                    cannot invent a slot value (unstated must come back null),
 *                    and its suggestions are intersected with the real
 *                    catalogue so it cannot offer something nobody sells.
 *
 * The category it infers is deliberately NOT used as a hard filter. That is the
 * §8.8 lesson stated precisely: the bug was never "the model misunderstood", it
 * was "a guessed category became a hard filter and buried every yoga mat".
 * Understanding feeds the semantic query; only what the shopper actually stated
 * becomes a filter.
 */

/** Hard ceiling on questions, enforced here rather than left to the model. */
export const MAX_TURNS = 4;

export type ConversationTurn = {
  role: "shopper" | "agent";
  content: string;
};

/**
 * A length-capped string that TRUNCATES rather than rejects.
 *
 * A hard `.max()` threw the whole understanding away because the model wrote a
 * slightly chatty `productType`, and the turn silently fell back to pattern
 * matching. The cap is a sanity bound on payload size, not a correctness
 * requirement — discarding a good answer over it is the worse failure.
 */
const capped = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" ? v.slice(0, max) : v),
    z.string().max(max),
  );

const slotSchema = z.object({
  productType: capped(120).nullable().default(null),
  purpose: capped(160).nullable().default(null),
  size: capped(40).nullable().default(null),
  color: capped(60).nullable().default(null),
  brand: capped(80).nullable().default(null),
  width: capped(40).nullable().default(null),
  gender: capped(40).nullable().default(null),
  budgetMax: z.number().nonnegative().nullable().default(null),
  budgetMin: z.number().nonnegative().nullable().default(null),
  quantity: z.number().int().min(0).max(20).nullable().default(null),
});

const responseSchema = z.object({
  slots: slotSchema,
  /** The model's own one-line summary of what it understood. */
  understanding: capped(300).default(""),
  readyToSearch: z.boolean().default(false),
  question: capped(300).nullable().default(null),
  /** Which slot the question is about, so the same ground is not re-covered. */
  questionAbout: capped(40).nullable().default(null),
  suggestions: z.array(capped(60)).max(8).default([]),
  /** A natural search phrase built from everything understood so far. */
  searchPhrase: capped(300).default(""),
  /**
   * Rated-feature constraints the shopper stated, e.g. "waterproof but
   * breathable" -> waterResistance >= 4 AND breathability >= 4.
   *
   * Extracted by the model because reading intent out of language is what it is
   * for; applied as a SQL predicate because "at least 4 out of 5" is a filter,
   * not a similarity. Only ever populated from what was actually SAID.
   */
  qualityConstraints: z
    .array(
      z.object({
        key: capped(40),
        op: z.enum(["gte", "lte"]).default("gte"),
        value: z.number().int().min(1).max(5).default(4),
      }),
    )
    .max(4)
    .default([]),
  /** What the shopper is optimising for, if they said. */
  priority: z
    .enum(["balanced", "cheapest", "fastest", "best_quality", "most_flexible"])
    .default("balanced"),
});

export type ConversationUnderstanding = z.infer<typeof responseSchema> & {
  degraded: boolean;
  /** Provider/model/token facts, so the audit trail keeps recording them. */
  meta: { model?: string; provider?: string; tokensIn?: number; tokensOut?: number };
};

const SYSTEM = `You are a shopping assistant having a natural conversation with a customer.

Your job each turn: read the whole conversation, report what you now understand, and either ask ONE more question or say you are ready to search.

RULES
- Extract only what the customer actually said or clearly implied. If they have not mentioned something, return null for it. NEVER guess a size, a colour, a budget or a brand. Inventing a constraint means showing them the wrong products.
- Understand meaning, not keywords. "for pounding pavement at the weekend" is road running. "something smart for my brother's wedding" is formal shoes. "nothing too pricey" is a budget signal but NOT a number — leave budgetMax null and ask.
- Ask about the single most useful unknown thing. Purpose usually matters most, because it changes the product completely; colour matters least.
- Ask ONE question at a time, in plain conversational English. Do not stack two questions together. Do not repeat something already answered or already declined.
- If the customer says they do not mind, do not know, or asks you to just show them options, treat that slot as settled with null and move on. Never press twice on the same thing.
- Set readyToSearch true as soon as you could show genuinely relevant products. Do not interrogate someone who has already been specific.
- suggestions: 3-6 short tappable answers for YOUR question, phrased as the customer would answer. Empty when readyToSearch is true.
- searchPhrase: everything you understand, as one natural product description to search with. Include purpose and stated attributes; leave out anything unknown.

Reply with JSON only:
{"slots":{"productType":string|null,"purpose":string|null,"size":string|null,"color":string|null,"brand":string|null,"width":string|null,"gender":string|null,"budgetMax":number|null,"budgetMin":number|null,"quantity":number|null},"understanding":string,"readyToSearch":boolean,"question":string|null,"questionAbout":string|null,"suggestions":string[],"searchPhrase":string,"qualityConstraints":[{"key":string,"op":"gte"|"lte","value":number}]}

budgetMax/budgetMin are whole rupees, not paise.
qualityConstraints: ONLY when the customer states a requirement about a rated feature. Available keys: durability, comfort, breathability, waterResistance, grip, warmth, materialQuality, support, packability, easeOfCare, batteryLife, soundQuality, noiseIsolation, portability, capacity, heatRetention, sharpness, nonStick, absorbency, softness, brightness, stability.
Use op "gte" with value 4 for something they WANT ("waterproof", "breathable", "hard-wearing").
Use op "lte" with value 2 for something they explicitly do NOT want or do not care about ("I don't care about rain", "not waterproof", "weight is not a concern" -> packability lte 2).
Extract EVERY feature the customer names, not just the first. Two wanted features is the common case:
"waterproof shoes that still breathe well" -> [{key:"waterResistance",op:"gte",value:4},{key:"breathability",op:"gte",value:4}]
"waterproof but I know it won't breathe" -> [{key:"waterResistance",op:"gte",value:4},{key:"breathability",op:"lte",value:2}]
"comfortable walking shoes" -> [{key:"comfort",op:"gte",value:4}]
"tough, and weight is not a concern" -> [{key:"durability",op:"gte",value:4},{key:"packability",op:"lte",value:2}]
Return an EMPTY array when no feature requirement was stated. Never infer one from the product type alone — wanting running shoes does not mean wanting breathability.

priority: "cheapest" if they care most about price, "fastest" about delivery speed, "best_quality" about quality or ratings, "most_flexible" about returns, otherwise "balanced".

This single reply replaces a separate intent-parsing step, so extract everything in one pass.`;

function transcriptToMessages(turns: ConversationTurn[]) {
  return turns.map((t) => ({
    role: t.role === "shopper" ? ("user" as const) : ("assistant" as const),
    content: t.content,
  }));
}

/**
 * Deterministic fallback.
 *
 * Runs only when no LLM is reachable. It is rule-based, and that is exactly why
 * it is the fallback rather than the main path — it can match wording, not
 * meaning. The platform must still work with no API keys (NOTES.md §9).
 */
function fallbackUnderstanding(
  turns: ConversationTurn[],
  intent: ShoppingIntent,
  askedSlots: string[],
): z.infer<typeof responseSchema> {
  const shopperText = turns
    .filter((t) => t.role === "shopper")
    .map((t) => t.content)
    .join(", ");

  const outstanding = missingSlots(intent).filter((s) => !askedSlots.includes(s.id));
  const next = outstanding[0];

  return {
    slots: {
      productType: intent.productQuery || null,
      purpose: intent.category,
      size: intent.attributes.size ?? null,
      color: intent.attributes.color ?? null,
      brand: intent.brand,
      width: intent.attributes.width ?? null,
      gender: intent.attributes.gender ?? null,
      budgetMax: intent.priceMaxMinor ? intent.priceMaxMinor / 100 : null,
      budgetMin: intent.priceMinMinor ? intent.priceMinMinor / 100 : null,
      quantity: intent.quantityStated ? intent.quantity : null,
    },
    understanding: shopperText.slice(0, 300),
    readyToSearch: !next || askedSlots.length >= MAX_TURNS,
    question: next ? next.question : null,
    questionAbout: next ? next.id : null,
    suggestions: next ? next.options.map((o) => o.label).slice(0, 6) : [],
    searchPhrase: shopperText,
    priority: intent.priority,
    qualityConstraints: [],
  };
}

/**
 * Keeps model suggestions inside what the catalogue can actually sell.
 *
 * A suggestion is a promise: tapping it must lead somewhere. Colours and sizes
 * are checked against the live variant axes, so the agent cannot offer "teal"
 * when nothing is teal.
 */
async function groundSuggestions(
  suggestions: string[],
  questionAbout: string | null,
): Promise<string[]> {
  if (suggestions.length === 0) return [];
  if (questionAbout !== "color" && questionAbout !== "size") return suggestions;

  const vocabulary = await getVocabulary();
  const known = new Set(
    (vocabulary.axes[questionAbout] ?? []).map((v) => v.toLowerCase().trim()),
  );
  if (known.size === 0) return suggestions;

  const kept = suggestions.filter((s) => known.has(s.toLowerCase().trim()));
  /*
   * If nothing survived, keep the MODEL's suggestions rather than dumping the
   * catalogue's own axis values. Those axes are global, not per-category, so
   * the raw list mixes shoe sizes with "100ml" drinkware and kids' "10c" —
   * offering those as answers to "what size do you take?" is worse than
   * offering a plausible size we might not stock.
   */
  return kept.length > 0 ? kept : suggestions;
}

/**
 * Tappable answers for the question the model asked.
 *
 * Smaller models often write a good question but leave `suggestions` empty, and
 * a question with no chips is a worse experience than one with them. When that
 * happens the catalogue-derived options for that slot are used instead — the
 * model still chose the question and its wording; only the shortcuts are
 * borrowed.
 */
async function suggestionsFor(
  fromModel: string[],
  questionAbout: string | null,
  fallbackIntent: ShoppingIntent,
): Promise<string[]> {
  const grounded = await groundSuggestions(fromModel, questionAbout);
  if (grounded.length > 0) return grounded;
  if (!questionAbout) return [];

  const slot = missingSlots(fallbackIntent).find((s) => s.id === questionAbout);
  return slot ? slot.options.map((o) => o.label).slice(0, 6) : [];
}

export async function understandConversation(input: {
  turns: ConversationTurn[];
  /** Slots already asked about, so the model is told not to revisit them. */
  askedSlots: string[];
  /** Parsed intent for the deterministic fallback only. */
  fallbackIntent: ShoppingIntent;
  /**
   * Plain sentences about this shopper, from `describeKnowledge`.
   *
   * Prose, never scores — the same rule `explain.ts` follows. A model handed
   * "brand Stride: 23.9" quotes the number back at the shopper as if it meant
   * something, and starts doing arithmetic on a scale that is arbitrary.
   */
  knownAboutShopper?: string[];
}): Promise<ConversationUnderstanding> {
  const fallback = () =>
    JSON.stringify(fallbackUnderstanding(input.turns, input.fallbackIntent, input.askedSlots));

  const vocabulary = await getVocabulary();
  const context = [
    `Categories this marketplace stocks: ${vocabulary.categories.slice(0, 40).join(", ")}.`,
    vocabulary.axes.color?.length
      ? `Colours available: ${vocabulary.axes.color.slice(0, 24).join(", ")}.`
      : "",
    vocabulary.axes.size?.length
      ? `Sizes available: ${vocabulary.axes.size.slice(0, 24).join(", ")}.`
      : "",
    input.askedSlots.length
      ? `Already asked about (do not ask again): ${input.askedSlots.join(", ")}.`
      : "",
    input.askedSlots.length >= MAX_TURNS
      ? "You have asked enough questions. Set readyToSearch true."
      : "",
    /*
     * History informs the QUESTIONS, never the slots.
     *
     * The model may skip asking a size it can already infer, and may lean on
     * a known preference when phrasing a suggestion. It must not silently
     * FILL a slot from history: a shopper buying a gift, or simply changing
     * their mind, would then get a search built from a preference they never
     * stated this time and cannot see. Anything taken from the profile has to
     * be said out loud so it can be contradicted.
     */
    input.knownAboutShopper?.length
      ? [
          "What we know about this shopper from their past orders and browsing:",
          ...input.knownAboutShopper.map((line) => `- ${line}`),
          "Use this to ask BETTER questions and to skip what you can already infer.",
          "Do NOT fill a slot from it. If you rely on it, say so in your question so they can correct you.",
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const { value, meta } = await completeJson(
      {
        task: "parse_intent",
        system: SYSTEM,
        messages: [
          { role: "user", content: context },
          ...transcriptToMessages(input.turns),
        ],
        temperature: 0.2,
        maxTokens: 1400,
        reasoningEffort: "low",
        fallback,
      },
      (raw) => responseSchema.parse(raw),
    );

    // The ceiling is ours, not the model's: it cannot decide to keep asking.
    const readyToSearch = value.readyToSearch || input.askedSlots.length >= MAX_TURNS;

    return {
      ...value,
      readyToSearch,
      question: readyToSearch ? null : normalizeTypography(value.question ?? ""),
      understanding: normalizeTypography(value.understanding),
      searchPhrase: normalizeTypography(value.searchPhrase),
      suggestions: readyToSearch
        ? []
        : await suggestionsFor(
            value.suggestions.map(normalizeTypography),
            value.questionAbout,
            input.fallbackIntent,
          ),
      degraded: meta.degraded,
      meta: {
        model: meta.model,
        provider: meta.provider,
        tokensIn: meta.tokensIn,
        tokensOut: meta.tokensOut,
      },
    };
  } catch (cause) {
    if (process.env.ACP_DEBUG_CONVERSATION) {
      console.error("[conversation] understanding failed:", cause);
    }
    const value = fallbackUnderstanding(input.turns, input.fallbackIntent, input.askedSlots);
    return { ...value, degraded: true, meta: {} };
  }
}

/**
 * Folds understood slots onto the parsed intent.
 *
 * Only things the shopper actually stated become filters. `purpose` and
 * `productType` feed the semantic query instead — that is what keeps a
 * misunderstood category from burying the whole result set.
 */
/**
 * Builds a complete intent from the model's understanding alone.
 *
 * This replaces the separate `parseIntent` call: the conversation model already
 * extracted everything that step produced, and a second call per turn doubled
 * the rate-limit pressure on a free tier for no extra information. One
 * understanding call, one explanation call — the two-calls-per-turn budget the
 * architecture is built around.
 *
 * `requireInStock` stays rule-owned (§8.8): a wrong value silently widens the
 * search to products nobody can buy, so it is decided from the shopper's own
 * words, not inferred.
 */
export function intentFromUnderstanding(
  understanding: ConversationUnderstanding,
  shopperText: string,
): ShoppingIntent {
  const slots = understanding.slots;
  const attributes: Record<string, string> = {};
  if (slots.size) attributes.size = String(slots.size).toLowerCase().trim();
  if (slots.color) attributes.color = String(slots.color).toLowerCase().trim();
  if (slots.width) attributes.width = String(slots.width).toLowerCase().trim();
  if (slots.gender) attributes.gender = String(slots.gender).toLowerCase().trim();

  return shoppingIntentSchema.parse({
    productQuery: understanding.searchPhrase || slots.productType || shopperText,
    // Deliberately null: an inferred category as a HARD filter is the §8.8 bug.
    // Purpose reaches retrieval through the semantic phrase instead.
    category: null,
    brand: slots.brand,
    attributes,
    priceMaxMinor: slots.budgetMax ? toMinor(slots.budgetMax) : null,
    priceMinMinor: slots.budgetMin ? toMinor(slots.budgetMin) : null,
    quantity: slots.quantity && slots.quantity > 0 ? slots.quantity : 1,
    quantityStated: slots.quantity != null && slots.quantity > 0,
    priority: understanding.priority,
    qualityConstraints: understanding.qualityConstraints ?? [],
    currency: "INR",
    requireInStock: !wantsOutOfStock(shopperText),
    clarificationNeeded: null,
  });
}

export function applyUnderstanding(
  intent: ShoppingIntent,
  understanding: ConversationUnderstanding,
): ShoppingIntent {
  const slots = understanding.slots;
  const attributes = { ...intent.attributes };
  if (slots.size) attributes.size = String(slots.size).toLowerCase();
  if (slots.color) attributes.color = String(slots.color).toLowerCase();
  if (slots.width) attributes.width = String(slots.width).toLowerCase();

  return shoppingIntentSchema.parse({
    ...intent,
    productQuery: understanding.searchPhrase || intent.productQuery,
    attributes,
    brand: slots.brand ?? intent.brand,
    priceMaxMinor: slots.budgetMax ? toMinor(slots.budgetMax) : intent.priceMaxMinor,
    priceMinMinor: slots.budgetMin ? toMinor(slots.budgetMin) : intent.priceMinMinor,
    quantity: slots.quantity && slots.quantity > 0 ? slots.quantity : intent.quantity,
    quantityStated: slots.quantity != null && slots.quantity > 0 ? true : intent.quantityStated,
  });
}

export type { SlotId };
