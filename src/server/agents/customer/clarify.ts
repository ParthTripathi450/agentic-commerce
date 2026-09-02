import { formatMoney } from "@/lib/money";
import type { ShoppingIntent } from "./intent-schema";

/**
 * Slot-filling for the conversational shopper.
 *
 * **Rules decide what is missing; the model only phrases the question.** This is
 * the same discipline as `category` and `requireInStock` (NOTES.md §8.8), and
 * for the same reason: a model asked "what should I ask next?" will happily
 * invent a constraint the shopper never mentioned, and then filter on it. Here
 * the question set is derived from the intent and the catalogue's own facets,
 * so the agent can only ask about things it can actually search on.
 *
 * The other half of the anti-hallucination story is that an unanswered slot is
 * left NULL rather than guessed. "I want shoes" must not silently become
 * "men's black running shoes size 9".
 */

export type SlotId = "purpose" | "size" | "color" | "budget" | "width" | "gender";

export type SlotOption = {
  /** What the shopper sees. */
  label: string;
  /** What gets merged into the intent when chosen. */
  value: string;
};

export type Slot = {
  id: SlotId;
  /** Deterministic fallback wording, used verbatim when no LLM is reachable. */
  question: string;
  /** Quick-reply chips. Always offered alongside a free-text answer. */
  options: SlotOption[];
  /** Whether the shopper may skip this one. */
  skippable: boolean;
  /** Why the agent wants it — shown as helper text, never invented by a model. */
  rationale: string;
};

/** Footwear is the deepest part of this catalogue, so it has the richest slots. */
const FOOTWEAR_CATEGORIES = new Set([
  "running shoes", "trail shoes", "sneakers", "football boots", "cricket shoes",
  "basketball shoes", "formal shoes", "hiking boots", "training shoes",
  "walking shoes", "kids shoes", "sandals",
]);

const FOOTWEAR_PURPOSES: SlotOption[] = [
  { label: "Road running", value: "road running shoes" },
  { label: "Marathon / racing", value: "carbon plate marathon racing shoes" },
  { label: "Trail running", value: "trail running shoes" },
  { label: "Gym / training", value: "cross training gym shoes" },
  { label: "Walking / everyday", value: "comfortable walking shoes" },
  { label: "Casual sneakers", value: "casual sneakers" },
  { label: "Formal / office", value: "leather formal shoes" },
  { label: "Football", value: "football boots" },
  { label: "Basketball", value: "basketball shoes" },
  { label: "Hiking", value: "hiking boots" },
];

const SHOE_SIZES: SlotOption[] = ["6", "7", "8", "9", "10", "11", "12"].map((s) => ({
  label: `UK ${s}`,
  value: s,
}));

const COLORS: SlotOption[] = [
  "black", "white", "blue", "grey", "red", "green", "brown", "navy",
].map((c) => ({ label: c[0].toUpperCase() + c.slice(1), value: c }));

const BUDGETS: SlotOption[] = [
  { label: "Under ₹2,500", value: "under 2500" },
  { label: "₹2,500 – ₹6,000", value: "between 2500 and 6000" },
  { label: "₹6,000 – ₹12,000", value: "between 6000 and 12000" },
  { label: "Over ₹12,000", value: "above 12000" },
];

const WIDTHS: SlotOption[] = [
  { label: "Regular", value: "regular width" },
  { label: "Wide fit", value: "wide fit" },
  { label: "Narrow", value: "narrow width" },
];

/** Broad enough that searching on it alone returns most of the catalogue. */
const VAGUE_QUERIES =
  /^\s*(?:i\s+(?:want|need|am looking for|'?m looking for)\s+)?(?:some\s+|a\s+|an\s+|new\s+)*(shoes?|footwear|trainers?|sneakers?|boots?|clothes|clothing|something)\s*\.?\s*$/i;

export function isFootwear(category: string | null, productQuery: string): boolean {
  if (category && FOOTWEAR_CATEGORIES.has(category.toLowerCase())) return true;
  return /\b(shoe|shoes|footwear|sneaker|sneakers|trainer|trainers|boot|boots|cleat|cleats|loafer|loafers|sandal|sandals)\b/i.test(
    productQuery,
  );
}

/**
 * True when the request names a product type but nothing that narrows it.
 *
 * "shoes" is the case the shopper asked us to handle: searchable, but so broad
 * that ranking it would be arbitrary rather than helpful.
 */
export function isTooBroad(intent: ShoppingIntent): boolean {
  if (VAGUE_QUERIES.test(intent.productQuery)) return true;
  const words = intent.productQuery.trim().split(/\s+/).filter(Boolean);
  const hasConstraint =
    intent.brand !== null ||
    intent.priceMaxMinor !== null ||
    intent.priceMinMinor !== null ||
    Object.keys(intent.attributes).length > 0;
  return words.length <= 2 && !hasConstraint;
}

/**
 * Which slots are still unknown, most useful first.
 *
 * Purpose leads because it is the single biggest discriminator in footwear —
 * a marathon racer and an Oxford brogue share almost no other attribute.
 */
export function missingSlots(intent: ShoppingIntent): Slot[] {
  if (!isFootwear(intent.category, intent.productQuery)) return genericSlots(intent);

  const slots: Slot[] = [];
  const attrs = intent.attributes;
  const query = intent.productQuery.toLowerCase();

  const purposeKnown =
    intent.category !== null ||
    /\b(running|marathon|race|racing|trail|gym|training|lift|walk|walking|casual|sneaker|formal|office|wedding|football|soccer|basketball|cricket|hiking|hike|school|sandal|slide)\b/.test(
      query,
    );
  if (!purposeKnown) {
    slots.push({
      id: "purpose",
      question: "What will you mostly use them for?",
      options: FOOTWEAR_PURPOSES,
      skippable: false,
      rationale: "Purpose changes the shoe completely — a racing flat and an office brogue share nothing.",
    });
  }

  if (!attrs.size) {
    slots.push({
      id: "size",
      question: "What size do you take?",
      options: SHOE_SIZES,
      skippable: true,
      rationale: "So I only show pairs actually in stock in your size.",
    });
  }

  if (!attrs.color) {
    slots.push({
      id: "color",
      question: "Any colour preference?",
      options: [...COLORS, { label: "No preference", value: "" }],
      skippable: true,
      rationale: "Optional — I will not narrow on colour unless you want me to.",
    });
  }

  if (intent.priceMaxMinor === null && intent.priceMinMinor === null) {
    slots.push({
      id: "budget",
      question: "What is your budget?",
      options: [...BUDGETS, { label: "No limit", value: "" }],
      skippable: true,
      rationale: "Footwear here runs from ₹1,499 to ₹18,999, so this narrows a lot.",
    });
  }

  if (!attrs.width && purposeKnown && /\b(wide|narrow|width|fit)\b/.test(query)) {
    slots.push({
      id: "width",
      question: "Which fitting do you need?",
      options: WIDTHS,
      skippable: true,
      rationale: "Several models come in wide and narrow lasts.",
    });
  }

  return slots;
}

/** Non-footwear still gets budget and colour, which every category supports. */
function genericSlots(intent: ShoppingIntent): Slot[] {
  const slots: Slot[] = [];
  if (intent.priceMaxMinor === null && intent.priceMinMinor === null) {
    slots.push({
      id: "budget",
      question: "What is your budget?",
      options: [...BUDGETS, { label: "No limit", value: "" }],
      skippable: true,
      rationale: "So I can rule out anything above what you want to spend.",
    });
  }
  if (!intent.attributes.color) {
    slots.push({
      id: "color",
      question: "Any colour preference?",
      options: [...COLORS, { label: "No preference", value: "" }],
      skippable: true,
      rationale: "Optional.",
    });
  }
  return slots;
}

/**
 * How many questions to ask before searching anyway.
 *
 * An agent that interrogates forever is as useless as one that guesses. Three
 * is enough to turn "shoes" into something rankable.
 */
export const MAX_QUESTIONS = 3;

export type ClarifyDecision =
  | { ask: true; slot: Slot; asked: SlotId[] }
  | { ask: false; reason: "specific_enough" | "enough_asked" | "nothing_left" };

/**
 * Decides whether to ask another question.
 *
 * `answered` is what the shopper has already responded to — asking the same
 * thing twice is the fastest way to look like a bad chatbot.
 */
export function nextQuestion(intent: ShoppingIntent, answered: SlotId[]): ClarifyDecision {
  const outstanding = missingSlots(intent).filter((s) => !answered.includes(s.id));

  // Nothing left to ask about — every slot the catalogue supports is known.
  // A fully specified opening request lands here on the first turn and is
  // searched immediately, which is why a precise shopper is never interrogated.
  if (outstanding.length === 0) return { ask: false, reason: "nothing_left" };

  // Otherwise keep narrowing, up to the cap. Purpose, colour and budget are all
  // worth asking even once the request is searchable: the shopper asked to be
  // asked rather than guessed at, and `applyAnswer` treats a skip as silence.
  if (answered.length >= MAX_QUESTIONS) return { ask: false, reason: "enough_asked" };

  return { ask: true, slot: outstanding[0], asked: answered };
}

/**
 * Folds an answer back into the query text.
 *
 * Answers become natural language appended to the shopper's own words, which
 * the existing UNDERSTAND step then re-parses. That keeps ONE parser: there is
 * no second, divergent path that turns chips into filters directly.
 */
export function applyAnswer(message: string, slot: SlotId, answer: string): string {
  const value = answer.trim();
  if (!value) return message;
  if (slot === "size") return `${message}, size ${value}`;
  if (slot === "color") return `${message}, ${value}`;
  return `${message}, ${value}`;
}

/** Human summary of what the agent believes, shown before it searches. */
export function describeKnown(intent: ShoppingIntent): string[] {
  const parts: string[] = [intent.productQuery];
  if (intent.category) parts.push(intent.category);
  if (intent.brand) parts.push(`brand ${intent.brand}`);
  for (const [k, v] of Object.entries(intent.attributes)) parts.push(`${k} ${v}`);
  if (intent.priceMaxMinor) parts.push(`under ${formatMoney(intent.priceMaxMinor)}`);
  if (intent.priceMinMinor) parts.push(`over ${formatMoney(intent.priceMinMinor)}`);
  if (intent.quantity > 1) parts.push(`quantity ${intent.quantity}`);
  return parts;
}
