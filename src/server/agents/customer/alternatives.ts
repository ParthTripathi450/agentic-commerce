import { sql } from "drizzle-orm";
import { db } from "@/db";
import { inventory, productVariants } from "@/db/schema";
import { formatMoney } from "@/lib/money";
import { hybridSearch, type Candidate, type SearchResult, type StructuredQuery } from "@/server/catalog/search";
import type { ShoppingIntent } from "./intent-schema";

/**
 * Closest available products when the exact ask cannot be filled.
 *
 * The agent exists to sell. A shopper who asks for size 15 and is told "no
 * results" leaves; a shopper who is told "we don't have 15 in these, but here
 * are the same shoes in 6-12" might still buy, and has been told the truth
 * either way. Showing nothing is the one outcome that helps no one.
 *
 * The line this must not cross is the relevance gate. There are two different
 * empty results and they deserve opposite treatment:
 *
 *   noRelevantMatch = true   Nothing in the catalogue is this kind of thing
 *                            ("a gaming laptop"). Offering shoes instead is the
 *                            hallucination §6 exists to prevent. NO alternatives.
 *
 *   noRelevantMatch = false  We stock this kind of thing; a hard filter removed
 *                            every option ("purple formal shoes", "size 15").
 *                            THIS is where alternatives belong.
 *
 * And they are never presented as matches. Every alternative carries the exact
 * ways it differs from what was asked, so the shopper is choosing a substitute
 * knowingly rather than being quietly sold something else.
 */

export type Alternative = {
  candidate: Candidate;
  /** Plain statements of how this differs from the request. Never empty. */
  differences: string[];
  /**
   * How far this is from what was asked, weighted by KIND of difference.
   *
   * Not a count. Counting made the ranking exactly backwards: a different
   * product that happens to be the right colour has FEWER differences than the
   * right product in another colour, so "navy" on a request for a navy jacket
   * would surface a navy backpack ahead of the same jacket in black.
   */
  distance: number;
};

export type AlternativesResult = {
  alternatives: Alternative[];
  /** What was set aside to find them, for the message shown to the shopper. */
  dropped: string[];
};

const EMPTY: AlternativesResult = { alternatives: [], dropped: [] };

/** Attributes that describe the shopper, not the product's availability. */
const SOFT_ATTRIBUTES = new Set(["color", "colour", "width", "gender", "style"]);

/**
 * What each kind of mismatch costs, and the whole point of the module.
 *
 * A shopper who asks for a navy running shoe and cannot have navy wants the
 * same shoe in another colour. They do not want a navy rucksack. Colour is a
 * preference about a product they have already chosen the KIND of; the kind
 * itself is the request. So being a different sort of thing costs an order of
 * magnitude more than being a different colour, and no amount of colour
 * matching can buy its way back.
 */
const DIFFERENCE_COST = {
  /** Not the same sort of product at all. Disqualifying in all but name. */
  category: 100,
  /** Same kind of thing, different maker. */
  brand: 8,
  /** Costs more than they said, or less than they wanted. */
  price: 6,
  /** A size or fit they cannot wear — real, but about this product. */
  size: 4,
  /** Colour, style, width. What they would compromise on first. */
  soft: 1,
} as const;

function costOfAttribute(key: string): number {
  if (SOFT_ATTRIBUTES.has(key)) return DIFFERENCE_COST.soft;
  return DIFFERENCE_COST.size;
}

/**
 * How a candidate differs from what was asked.
 *
 * Pure and separately testable, because this text is the entire honesty of the
 * feature — if it under-reports a difference, the agent is mis-selling.
 */
export function describeDifferences(
  intent: ShoppingIntent,
  candidate: Candidate,
  availableAttributeValues: Record<string, string[]> = {},
  /**
   * The categories the shopper's own search recalled, before filtering.
   * A candidate outside them is a different sort of product, which is the one
   * difference that has to be said out loud.
   */
  anchorCategories: string[] = [],
): string[] {
  const out: string[] = [];

  if (anchorCategories.length > 0 && !anchorCategories.includes(candidate.category)) {
    out.push(`a ${candidate.category.toLowerCase()}, not what you were looking at`);
  }

  for (const [key, wanted] of Object.entries(intent.attributes)) {
    const actual = candidate.variant.attributes[key];
    if (actual && actual.toLowerCase() === String(wanted).toLowerCase()) continue;

    const available = availableAttributeValues[key];
    if (available?.length) {
      out.push(
        `no ${key} ${wanted} — available in ${available.slice(0, 6).join(", ")}`,
      );
    } else if (actual) {
      out.push(`${key} is ${actual}, not ${wanted}`);
    } else {
      out.push(`does not come in ${key} ${wanted}`);
    }
  }

  if (intent.priceMaxMinor && candidate.variant.priceMinor > intent.priceMaxMinor) {
    const over = candidate.variant.priceMinor - intent.priceMaxMinor;
    out.push(
      `${formatMoney(candidate.variant.priceMinor)} — ${formatMoney(over)} over your ${formatMoney(intent.priceMaxMinor)} budget`,
    );
  }

  if (intent.priceMinMinor && candidate.variant.priceMinor < intent.priceMinMinor) {
    out.push(`${formatMoney(candidate.variant.priceMinor)} — below the ${formatMoney(intent.priceMinMinor)} you wanted`);
  }

  if (intent.brand && candidate.brand && candidate.brand.toLowerCase() !== intent.brand.toLowerCase()) {
    out.push(`by ${candidate.brand}, not ${intent.brand}`);
  }

  return out;
}

/**
 * How far a candidate sits from the request, weighted by KIND of difference.
 *
 * Mirrors `describeDifferences` exactly — every line that function produces has
 * a cost here — so the order the shopper sees always matches the reasons they
 * are given. A ranking justified by text that did not drive it is not an
 * explanation.
 */
export function differenceDistance(
  intent: ShoppingIntent,
  candidate: Candidate,
  anchorCategories: string[] = [],
): number {
  let distance = 0;

  if (anchorCategories.length > 0 && !anchorCategories.includes(candidate.category)) {
    distance += DIFFERENCE_COST.category;
  }

  for (const [key, wanted] of Object.entries(intent.attributes)) {
    const actual = candidate.variant.attributes[key];
    if (actual && actual.toLowerCase() === String(wanted).toLowerCase()) continue;
    distance += costOfAttribute(key);
  }

  if (intent.priceMaxMinor && candidate.variant.priceMinor > intent.priceMaxMinor) {
    distance += DIFFERENCE_COST.price;
  }
  if (intent.priceMinMinor && candidate.variant.priceMinor < intent.priceMinMinor) {
    distance += DIFFERENCE_COST.price;
  }
  if (intent.brand && candidate.brand && candidate.brand.toLowerCase() !== intent.brand.toLowerCase()) {
    distance += DIFFERENCE_COST.brand;
  }

  return distance;
}

/**
 * Nearest first, by weighted distance rather than by number of differences.
 *
 * Counting was actively wrong. Against "navy running shoes", a navy rucksack
 * matches on colour and so has one FEWER difference than the same running shoe
 * in black — counting put the rucksack first, which is the complaint this
 * ordering exists to answer. Weighting lets the right KIND of product win
 * however many small things it gets wrong.
 */
export function rankByCloseness(alternatives: Alternative[]): Alternative[] {
  return [...alternatives].sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    // Then by retrieval relevance, so the nearest thing wins the tie.
    return b.candidate.retrieval.rrf - a.candidate.retrieval.rrf;
  });
}

/**
 * Finds buyable near-misses for a request that matched nothing.
 *
 * Stock is never relaxed. An out-of-stock alternative is not an alternative —
 * it cannot be sold, and offering it wastes the one chance to recover the sale.
 */
export async function findAlternatives(input: {
  intent: ShoppingIntent;
  query: StructuredQuery;
  search: SearchResult;
  limit?: number;
}): Promise<AlternativesResult> {
  // The guard. See the note at the top of this file.
  if (input.search.noRelevantMatch) return EMPTY;
  if (input.search.candidates.length > 0) return EMPTY;

  const dropped: string[] = [];
  const relaxed: StructuredQuery = { ...input.query, limit: (input.limit ?? 4) * 4 };

  /*
   * What the shopper was actually looking at.
   *
   * The products the filter REJECTED are the right kind of thing in the wrong
   * colour or size — they matched everything else. Their categories are
   * therefore the best available statement of what was being shopped for, and
   * anchoring on them is what stops "navy running shoes" from being answered
   * with a navy rucksack. Falling back to the recalled set covers the case
   * where nothing was rejected by name.
   */
  const anchorCategories = anchorsFrom(input.search, input.query.category);

  // Attributes go first: they are preferences about the product, and the
  // shopper can see for themselves what colours and sizes actually exist.
  const droppedSoftValues: string[] = [];
  if (relaxed.attributes && Object.keys(relaxed.attributes).length > 0) {
    for (const [key, value] of Object.entries(relaxed.attributes)) {
      dropped.push(SOFT_ATTRIBUTES.has(key) ? key : `${key} ${value}`);
      if (SOFT_ATTRIBUTES.has(key) && value) droppedSoftValues.push(String(value));
    }
    relaxed.attributes = {};
  }

  /*
   * A dropped constraint must stop steering retrieval, not just stop filtering.
   *
   * Clearing `attributes` removes the hard filter, but "navy" is still sitting
   * in the semantic phrase, so the embedding happily goes and finds navy things
   * — of any kind. The word has to leave the query text as well, or relaxing a
   * colour constraint quietly promotes colour to the most important term in the
   * search. Same failure as a focus answer leaking into the query and turning
   * a search for shoes into a search for shorts.
   */
  if (droppedSoftValues.length > 0 && relaxed.text) {
    relaxed.text = stripWords(relaxed.text, droppedSoftValues);
  }
  if (relaxed.priceMaxMinor) {
    dropped.push(`under ${formatMoney(relaxed.priceMaxMinor)}`);
    relaxed.priceMaxMinor = null;
  }
  if (relaxed.priceMinMinor) {
    dropped.push(`over ${formatMoney(relaxed.priceMinMinor)}`);
    relaxed.priceMinMinor = null;
  }
  if (relaxed.brand) {
    dropped.push(`brand ${relaxed.brand}`);
    relaxed.brand = null;
  }

  // Nothing was actually constraining the search, so there is nothing to widen.
  if (dropped.length === 0) return EMPTY;

  // Stock stays required: an unbuyable alternative is not an alternative.
  relaxed.requireInStock = true;

  const widened = await hybridSearch(relaxed);
  if (widened.candidates.length === 0 || widened.noRelevantMatch) return EMPTY;

  const askedKeys = Object.keys(input.intent.attributes);
  const availableByProduct = await loadAvailableAttributeValues(
    widened.candidates.map((c) => c.productId),
    askedKeys,
  );

  const alternatives: Alternative[] = widened.candidates.map((candidate) => ({
    candidate,
    differences: describeDifferences(
      input.intent,
      candidate,
      availableByProduct[candidate.productId] ?? {},
      anchorCategories,
    ),
    distance: differenceDistance(input.intent, candidate, anchorCategories),
  }));

  return {
    // A "substitute" identical to the request would mean the filter was wrong,
    // not that we found an alternative — so those are dropped. Deduping by
    // title matters as much: a product several merchants stock, or one whose
    // colours each recall separately, otherwise fills every slot with itself
    // and the shopper is offered one option four times.
    alternatives: dedupeByTitle(
      rankByCloseness(alternatives.filter((a) => a.differences.length > 0)),
    ).slice(0, input.limit ?? 4),
    dropped,
  };
}

/**
 * What these products are ACTUALLY available in, per attribute.
 *
 * Queried rather than inferred from the candidates: `candidate.variant` is a
 * single variant, so reading sizes off it would produce a list that is true of
 * no individual product. "Available in 6-12" is a claim to a customer, so it
 * has to come from the variants that genuinely exist and are in stock.
 */
async function loadAvailableAttributeValues(
  productIds: string[],
  keys: string[],
): Promise<Record<string, Record<string, string[]>>> {
  if (productIds.length === 0 || keys.length === 0) return {};

  const rows = await db
    .select({
      productId: productVariants.productId,
      attributes: productVariants.attributes,
    })
    .from(productVariants)
    .innerJoin(inventory, sql`${inventory.variantId} = ${productVariants.id}`)
    .where(
      sql`${productVariants.productId} IN ${productIds} AND ${productVariants.active} = true
          AND (${inventory.quantity} - ${inventory.reserved}) > 0`,
    );

  const byProduct: Record<string, Record<string, Set<string>>> = {};
  for (const row of rows) {
    const bucket = (byProduct[row.productId] ??= {});
    for (const key of keys) {
      const value = (row.attributes as Record<string, string>)[key];
      if (!value) continue;
      (bucket[key] ??= new Set()).add(value);
    }
  }

  return Object.fromEntries(
    Object.entries(byProduct).map(([productId, attrs]) => [
      productId,
      Object.fromEntries(
        Object.entries(attrs).map(([key, values]) => [key, sortValues([...values])]),
      ),
    ]),
  );
}

/** Numeric-aware sort so sizes read "6, 7, 8, 9, 10" rather than "10, 6, 7". */
function sortValues(values: string[]): string[] {
  return values.sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.localeCompare(b);
  });
}

/**
 * The categories the shopper was actually shopping in.
 *
 * Two sources, in order of authority.
 *
 * A category the shopper genuinely stated is definitive, so it wins outright.
 * Otherwise the evidence comes from products rejected for the ATTRIBUTE — those
 * matched everything else and failed on colour or size alone, so they are the
 * right kind of thing by construction, which no other rejection reason tells us.
 *
 * But that set needs thresholding, and the numbers say why. "Magenta backpack"
 * recalls 60 products across seven categories, because broad semantic recall is
 * meant to be generous, and any of them carrying a colour that is not magenta
 * is rejected on the attribute too. Taking all of them would wave a hoodie
 * through as "the right kind of thing" and reproduce the exact complaint. A
 * category appearing once or twice in sixty is recall noise; the kind of thing
 * actually being shopped for appears repeatedly, so only categories holding a
 * real share of the rejections are kept.
 *
 * Returning nothing is the honest answer when there is no such evidence:
 * `differenceDistance` then charges nothing for category rather than guessing,
 * and retrieval relevance orders the substitutes on its own.
 */
const ANCHOR_MIN_SHARE = 0.15;

function anchorsFrom(search: SearchResult, statedCategory?: string | null): string[] {
  if (statedCategory) return [statedCategory];

  const onAttribute = search.rejected
    .filter((r) => r.reason === "attribute_mismatch")
    .map((r) => r.category)
    .filter((c): c is string => Boolean(c));

  if (onAttribute.length === 0) return [];

  const counts = new Map<string, number>();
  for (const category of onAttribute) counts.set(category, (counts.get(category) ?? 0) + 1);

  const floor = Math.max(2, Math.ceil(onAttribute.length * ANCHOR_MIN_SHARE));
  return [...counts.entries()].filter(([, n]) => n >= floor).map(([category]) => category);
}

/**
 * Removes whole words from a search phrase, leaving the rest intact.
 *
 * Word-boundary matching, so dropping "red" does not maim "shredded", and
 * escaped because colour and style values come from the catalogue and a value
 * containing a regex metacharacter would otherwise throw — exactly how
 * `composeTitle` broke on "Dr. Martens".
 */
function stripWords(text: string, words: string[]): string {
  let out = text;
  for (const word of words) {
    const escaped = word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!escaped) continue;
    out = out.replace(new RegExp(`\\b${escaped}\\b`, "gi"), " ");
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

/** Keeps the closest listing of each product, discarding the rest. */
function dedupeByTitle(alternatives: Alternative[]): Alternative[] {
  const seen = new Set<string>();
  return alternatives.filter((a) => {
    const key = a.candidate.title.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
