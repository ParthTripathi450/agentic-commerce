import { toMinor } from "@/lib/money";
import type { Vocabulary } from "@/server/catalog/vocabulary";
import type { Priority } from "./ranker";
import type { ShoppingIntent } from "./intent-schema";

/**
 * Rule-based intent parsing.
 *
 * Serves two jobs: the deterministic fallback when no LLM is reachable, and a
 * safety net when a small free model returns unusable JSON. It handles the
 * shapes real shoppers type — "under ₹5,000", "size 10", "black", "cheapest" —
 * which covers the common case without a model at all.
 */

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const MAX_PATTERNS = [
  /(?:under|below|less than|cheaper than|within|upto|up to|at most|max(?:imum)?|budget of|no more than)\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)\s*(k|thousand)?/i,
  /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)\s*(k|thousand)?\s*(?:or less|or below|max)/i,
];

const MIN_PATTERNS = [
  /(?:above|over|more than|at least|minimum|starting (?:at|from))\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)\s*(k|thousand)?/i,
];

function parseAmountMinor(raw: string, multiplier?: string): number {
  const base = Number(raw.replace(/,/g, ""));
  const scaled = multiplier ? base * 1000 : base;
  return toMinor(scaled);
}

function matchAmount(text: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return parseAmountMinor(match[1], match[2]);
  }
  return null;
}

function detectPriority(text: string): Priority {
  const t = text.toLowerCase();
  if (/\b(cheapest|cheap|budget|lowest price|affordable|least expensive|save money)\b/.test(t))
    return "cheapest";
  if (/\b(fastest|urgent|asap|quickly|soonest|today|tomorrow|next day|immediately)\b/.test(t))
    return "fastest";
  if (/\b(best|premium|top rated|highest rated|quality|reliable)\b/.test(t)) return "best_quality";
  if (/\b(return|returnable|exchange|flexible|refund)\b/.test(t)) return "most_flexible";
  return "balanced";
}

/**
 * Phrasing that clearly means "more than one" without saying how many.
 *
 * Assuming 1 for these is a guess dressed as an answer — the shopper said
 * "a few pairs" and would receive one.
 */
const VAGUE_PLURAL =
  /\b(a few|a couple|couple of|some|several|multiple|many|bulk|in bulk|for (my|the) (team|family|office|group)|for everyone|for us all)\b/i;

export function hasVaguePlural(text: string): boolean {
  if (/\b\d+\b/.test(text)) return false; // an explicit number settles it
  return VAGUE_PLURAL.test(text);
}

function detectQuantity(text: string): number {
  const digit = text.match(/\b(\d+)\s*(?:x|pairs?|units?|pieces?|packs?|items?)\b/i);
  if (digit) return Math.max(1, Math.min(10, Number(digit[1])));
  const word = text.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:pairs?|units?|pieces?|packs?|items?)\b/i,
  );
  if (word) return NUMBER_WORDS[word[1].toLowerCase()] ?? 1;
  return 1;
}

/** Matches vocabulary terms as whole words, preferring the longest match. */
function matchVocabulary(text: string, options: string[]): string | null {
  const t = text.toLowerCase();
  const sorted = [...options].sort((a, b) => b.length - a.length);
  for (const option of sorted) {
    const escaped = option.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(t)) return option;
  }
  return null;
}

export function parseIntentWithRules(text: string, vocabulary: Vocabulary): ShoppingIntent {
  const attributes: Record<string, string> = {};

  // Explicit "size 10" / "size M" wins over a bare vocabulary match.
  const sizeMatch = text.match(/\bsizes?\s*[:\-]?\s*([a-z0-9.]{1,4})\b/i);
  if (sizeMatch && vocabulary.axes.size?.some((s) => s.toLowerCase() === sizeMatch[1].toLowerCase())) {
    attributes.size = vocabulary.axes.size.find(
      (s) => s.toLowerCase() === sizeMatch[1].toLowerCase(),
    )!;
  }

  for (const [axis, values] of Object.entries(vocabulary.axes)) {
    if (attributes[axis]) continue;
    // Bare numbers are ambiguous (a price, a quantity), so sizes need the
    // explicit "size N" form handled above.
    const candidates = axis === "size" ? values.filter((v) => /[a-z]/i.test(v)) : values;
    const found = matchVocabulary(text, candidates);
    if (found) attributes[axis] = found;
  }

  const category = matchVocabulary(text, vocabulary.categories);
  const brand = matchVocabulary(text, vocabulary.brands);

  // Strip constraint phrasing so the semantic query is about the product itself.
  const productQuery = text
    .replace(/(?:under|below|less than|within|upto|up to|at most|over|above|at least)\s*(?:₹|rs\.?|inr)?\s*[\d,]+\s*(?:k|thousand)?/gi, "")
    .replace(/\bsizes?\s*[:\-]?\s*[a-z0-9.]{1,4}\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return {
    productQuery: productQuery || text,
    category,
    brand,
    attributes,
    priceMaxMinor: matchAmount(text, MAX_PATTERNS),
    priceMinMinor: matchAmount(text, MIN_PATTERNS),
    quantity: detectQuantity(text),
    quantityStated: /\b\d+\s*(x|pairs?|units?|pieces?|packs?|items?)\b/i.test(text) ||
      /\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(pairs?|units?|pieces?|packs?|items?)\b/i.test(text),
    priority: detectPriority(text),
    currency: "INR",
    requireInStock: true,
    clarificationNeeded: hasVaguePlural(text)
      ? "You mentioned more than one but not how many. How many would you like?"
      : null,
  };
}
