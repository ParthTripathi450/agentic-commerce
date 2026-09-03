import { sql } from "drizzle-orm";
import { db } from "@/db";
import { formatMoney } from "@/lib/money";

/**
 * What is actually for sale, right now, in a given set of products.
 *
 * Every suggestion the agent offers is a promise: tapping "Black" must lead to
 * black shoes that can be bought today. So the chips are computed from live
 * variants and live inventory rather than from a static list — a colour nobody
 * stocks is never offered, and a price band with nothing in it is never shown.
 */

export type FacetValue = { value: string; label: string; count: number };

export type PriceBucket = {
  label: string;
  minMinor: number | null;
  maxMinor: number | null;
  count: number;
};

export type Facets = {
  attributes: Record<string, FacetValue[]>;
  /**
   * Rated features these products carry, best average first.
   *
   * Offered as "what would you like me to prioritise?" — so the question can
   * only ever name a feature the results are actually scored on.
   */
  ratedFeatures: { key: string; label: string; averageScore: number; products: number }[];
  priceBuckets: PriceBucket[];
  /** Cheapest and dearest in-stock variant, for phrasing the budget question. */
  priceRange: { minMinor: number; maxMinor: number } | null;
  inStockVariants: number;
};

const EMPTY: Facets = {
  attributes: {}, ratedFeatures: [], priceBuckets: [], priceRange: null, inStockVariants: 0,
};

/**
 * Bands chosen from the real price distribution, not hardcoded.
 *
 * Fixed bands ("under ₹2,500") are wrong the moment the catalogue changes: they
 * either bunch everything into one bucket or offer bands with nothing in them.
 * Quartiles guarantee every band shown actually contains stock, and roughly the
 * same amount of it, which is what makes the choice useful.
 */
export function bucketsFromPrices(pricesMinor: number[]): PriceBucket[] {
  const prices = [...pricesMinor].sort((a, b) => a - b);
  if (prices.length === 0) return [];

  const cheapest = prices[0];
  const dearest = prices[prices.length - 1];
  // Everything costs about the same — bands would be noise.
  if (dearest - cheapest < 50_00) {
    return [{ label: `Around ${formatMoney(cheapest)}`, minMinor: null, maxMinor: null, count: prices.length }];
  }

  const at = (fraction: number) => prices[Math.min(prices.length - 1, Math.floor(prices.length * fraction))];
  const cuts = [...new Set([at(0.25), at(0.5), at(0.75)])].sort((a, b) => a - b);

  const edges: Array<[number | null, number | null]> = [];
  let previous: number | null = null;
  for (const cut of cuts) {
    edges.push([previous, cut]);
    previous = cut;
  }
  edges.push([previous, null]);

  return edges
    .map(([min, max]) => {
      const count = prices.filter((p) => (min === null || p > min) && (max === null || p <= max)).length;
      const label =
        min === null
          ? `Under ${formatMoney(max!)}`
          : max === null
            ? `Over ${formatMoney(min)}`
            : `${formatMoney(min)} – ${formatMoney(max)}`;
      return { label, minMinor: min, maxMinor: max, count };
    })
    .filter((b) => b.count > 0);
}

/**
 * Facets for a set of products, from live variants and inventory.
 *
 * `productIds` normally comes from an unfiltered semantic search, so the facets
 * describe "shoes like the ones you asked about" rather than the whole
 * catalogue — offering "100ml" as a shoe size is exactly what this avoids.
 */
export async function computeFacets(
  productIds: string[],
  attributeKeys: string[] = ["color", "size", "width"],
): Promise<Facets> {
  if (productIds.length === 0) return EMPTY;

  const rows = await db
    .select({
      attributes: sql<Record<string, string>>`pv.attributes`,
      priceMinor: sql<number>`pv.price_minor`,
    })
    .from(sql`product_variants pv`)
    .innerJoin(sql`inventory i`, sql`i.variant_id = pv.id`)
    .where(
      sql`pv.product_id IN ${productIds}
          AND pv.active = true
          AND (i.quantity - i.reserved) > 0`,
    );

  if (rows.length === 0) return EMPTY;

  const counters: Record<string, Map<string, number>> = {};
  for (const key of attributeKeys) counters[key] = new Map();

  const prices: number[] = [];
  for (const row of rows) {
    prices.push(Number(row.priceMinor));
    for (const key of attributeKeys) {
      const value = row.attributes?.[key];
      if (!value) continue;
      counters[key].set(value, (counters[key].get(value) ?? 0) + 1);
    }
  }

  const attributes: Record<string, FacetValue[]> = {};
  for (const [key, counts] of Object.entries(counters)) {
    if (counts.size === 0) continue;
    attributes[key] = [...counts.entries()]
      .map(([value, count]) => ({
        value,
        label: key === "size" ? value : value[0].toUpperCase() + value.slice(1),
        count,
      }))
      .sort((a, b) => {
        if (key === "size") {
          const na = Number(a.value);
          const nb = Number(b.value);
          if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
        }
        return b.count - a.count;
      })
      .slice(0, 10);
  }

  return {
    attributes,
    ratedFeatures: await loadRatedFeatures(productIds),
    priceBuckets: bucketsFromPrices(prices),
    priceRange: { minMinor: Math.min(...prices), maxMinor: Math.max(...prices) },
    inStockVariants: rows.length,
  };
}


/** Which rated features these products publish, and how well they score. */
async function loadRatedFeatures(productIds: string[]) {
  if (productIds.length === 0) return [];

  const rows = (await db.execute(sql`
    SELECT q.key,
           ROUND(AVG((q.value)::int), 2)::float AS avg_score,
           count(*)::int AS products
    FROM products p, jsonb_each_text(p.attributes->'qualities') AS q(key, value)
    WHERE p.id IN ${productIds} AND p.status = 'active'
    GROUP BY q.key
    -- A feature only one product is rated on cannot separate the results.
    HAVING count(*) >= 3
    ORDER BY count(*) DESC, avg_score DESC
  `)) as unknown as { key: string; avg_score: number; products: number }[];

  return rows.map((r) => ({
    key: r.key,
    label: r.key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim(),
    averageScore: Number(r.avg_score),
    products: Number(r.products),
  }));
}
