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
 * How a candidate differs from what was asked.
 *
 * Pure and separately testable, because this text is the entire honesty of the
 * feature — if it under-reports a difference, the agent is mis-selling.
 */
export function describeDifferences(
  intent: ShoppingIntent,
  candidate: Candidate,
  availableAttributeValues: Record<string, string[]> = {},
): string[] {
  const out: string[] = [];

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

/** Ranks by how little a substitute deviates: fewest differences first. */
export function rankByCloseness(alternatives: Alternative[]): Alternative[] {
  return [...alternatives].sort((a, b) => {
    if (a.differences.length !== b.differences.length) {
      return a.differences.length - b.differences.length;
    }
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

  // Attributes go first: they are preferences about the product, and the
  // shopper can see for themselves what colours and sizes actually exist.
  if (relaxed.attributes && Object.keys(relaxed.attributes).length > 0) {
    for (const key of Object.keys(relaxed.attributes)) {
      dropped.push(SOFT_ATTRIBUTES.has(key) ? key : `${key} ${relaxed.attributes[key]}`);
    }
    relaxed.attributes = {};
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

  const alternatives = widened.candidates.map((candidate) => ({
    candidate,
    differences: describeDifferences(
      input.intent,
      candidate,
      availableByProduct[candidate.productId] ?? {},
    ),
  }));

  return {
    // A "substitute" identical to the request would mean the filter was wrong,
    // not that we found an alternative — so those are dropped.
    alternatives: rankByCloseness(alternatives.filter((a) => a.differences.length > 0))
      .slice(0, input.limit ?? 4),
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
