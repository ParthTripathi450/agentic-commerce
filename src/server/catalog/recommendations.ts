import { sql } from "drizzle-orm";
import { db } from "@/db";
import { complementsFor } from "./complements";

/**
 * "You might also like", grounded in real data.
 *
 * Two different questions, answered two different ways:
 *
 *   alsoBought  What other shoppers actually bought in the same order. Real
 *               co-purchase from `order_items`, so it surfaces genuine
 *               complements (boots and a shoe brush) rather than more of the
 *               same thing.
 *
 *   similar     Nearest neighbours by embedding, excluding the same product.
 *               These are the contrast picks — another take on what they just
 *               chose, from a different brand or at a different price.
 *
 * Both require live stock. Recommending something unbuyable wastes the moment
 * the shopper is most likely to add a second item.
 */

export type Recommendation = {
  productId: string;
  variantId: string;
  title: string;
  brand: string | null;
  category: string;
  merchantName: string;
  priceMinor: number;
  currency: string;
  imageUrl: string | null;
  ratingBp: number | null;
  ratingCount: number;
  /** Why it is being shown, in the shopper's terms. */
  reason: string;
};

const SELECT = sql`
  SELECT p.id                AS product_id,
         v.id                AS variant_id,
         p.title,
         p.brand,
         p.category,
         m.name              AS merchant_name,
         v.price_minor,
         v.currency,
         p.image_urls,
         p.rating_bp,
         p.rating_count
`;

type Row = {
  product_id: string;
  variant_id: string;
  title: string;
  brand: string | null;
  category: string;
  merchant_name: string;
  price_minor: number;
  currency: string;
  image_urls: string[] | null;
  rating_bp: number | null;
  rating_count: number;
};

function toRecommendation(row: Row, reason: string): Recommendation {
  return {
    productId: row.product_id,
    variantId: row.variant_id,
    title: row.title,
    brand: row.brand,
    category: row.category,
    merchantName: row.merchant_name,
    priceMinor: Number(row.price_minor),
    currency: row.currency,
    imageUrl: row.image_urls?.[0] ?? null,
    ratingBp: row.rating_bp,
    ratingCount: Number(row.rating_count ?? 0),
    reason,
  };
}

/**
 * One row per distinct product, keeping the first (best-ranked) occurrence.
 *
 * The same product is often stocked by several merchants and has many variants,
 * so a raw join returns "DryFit Training T-Shirt" three times. A recommendation
 * list that repeats itself looks broken and wastes the few slots available.
 */
function dedupe(recommendations: Recommendation[]): Recommendation[] {
  const seen = new Set<string>();
  const out: Recommendation[] = [];
  for (const rec of recommendations) {
    const key = rec.title.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }
  return out;
}

/** Products genuinely bought in the same order as this one. */
export async function alsoBought(productId: string, limit = 4): Promise<Recommendation[]> {
  const rows = (await db.execute(sql`
    WITH sibling AS (
      SELECT oi2.variant_id, count(*)::int AS times
      FROM order_items oi1
      JOIN order_items oi2 ON oi2.order_id = oi1.order_id AND oi2.variant_id <> oi1.variant_id
      JOIN product_variants v1 ON v1.id = oi1.variant_id
      WHERE v1.product_id = ${productId}
      GROUP BY oi2.variant_id
    )
    ${SELECT}, sibling.times
    FROM sibling
    JOIN product_variants v ON v.id = sibling.variant_id
    JOIN products p ON p.id = v.product_id
    JOIN merchants m ON m.id = p.merchant_id
    JOIN inventory i ON i.variant_id = v.id
    WHERE p.status = 'active' AND v.active
      AND (i.quantity - i.reserved) > 0
      AND p.id <> ${productId}
    ORDER BY sibling.times DESC, v.price_minor ASC
    LIMIT ${limit * 6}
  `)) as unknown as (Row & { times: number })[];

  return dedupe(
    rows.map((r) =>
      toRecommendation(
        r,
        r.times > 1 ? `Often bought with this (${r.times} orders)` : "Bought with this",
      ),
    ),
  ).slice(0, limit);
}

/**
 * Nearest neighbours by embedding, excluding the product itself.
 *
 * Uses the same vectors the search runs on, so "similar" means what it means
 * everywhere else in the system rather than a second, divergent notion.
 */
export async function similarTo(productId: string, limit = 4): Promise<Recommendation[]> {
  const rows = (await db.execute(sql`
    WITH anchor AS (
      SELECT embedding, product_id FROM catalog_documents WHERE product_id = ${productId} LIMIT 1
    )
    ${SELECT}, (cd.embedding <=> anchor.embedding) AS distance
    FROM anchor
    JOIN catalog_documents cd ON cd.product_id <> anchor.product_id
    JOIN products p ON p.id = cd.product_id
    JOIN merchants m ON m.id = p.merchant_id
    JOIN LATERAL (
      SELECT v.* FROM product_variants v
      JOIN inventory i ON i.variant_id = v.id
      WHERE v.product_id = p.id AND v.active AND (i.quantity - i.reserved) > 0
      ORDER BY v.price_minor ASC
      LIMIT 1
    ) v ON true
    WHERE p.status = 'active' AND anchor.embedding IS NOT NULL AND cd.embedding IS NOT NULL
    ORDER BY distance ASC
    LIMIT ${limit * 6}
  `)) as unknown as Row[];

  return dedupe(rows.map((r) => toRecommendation(r, "Similar to what you added"))).slice(0, limit);
}

/**
 * Best sellers from the categories that genuinely go WITH this one.
 *
 * The fallback that matters. Co-purchase is the better signal but is far too
 * sparse to cover the catalogue, and embedding similarity — the previous
 * fallback — answers "what else is like this?", which after a purchase is the
 * wrong question. It offered another pair of formal shoes to someone who had
 * just bought formal shoes.
 */
export async function goesWith(
  productId: string,
  category: string,
  limit = 4,
): Promise<Recommendation[]> {
  const categories = complementsFor(category);
  if (categories.length === 0) return [];

  const rows = (await db.execute(sql`
    WITH sold AS (
      SELECT v.product_id, SUM(oi.quantity)::int AS units
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN product_variants v ON v.id = oi.variant_id
      WHERE o.state IN ('paid','fulfilled')
      GROUP BY v.product_id
    )
    ${SELECT}, p.category AS anchor_category, COALESCE(sold.units, 0) AS units
    FROM products p
    JOIN merchants m ON m.id = p.merchant_id
    JOIN LATERAL (
      SELECT v.* FROM product_variants v
      JOIN inventory i ON i.variant_id = v.id
      WHERE v.product_id = p.id AND v.active AND (i.quantity - i.reserved) > 0
      ORDER BY v.price_minor ASC
      LIMIT 1
    ) v ON true
    LEFT JOIN sold ON sold.product_id = p.id
    WHERE p.status = 'active'
      AND p.id <> ${productId}
      AND p.category IN ${categories}
    ORDER BY COALESCE(sold.units, 0) DESC, p.rating_bp DESC NULLS LAST
    LIMIT ${limit * 6}
  `)) as unknown as Row[];

  return dedupe(
    rows.map((r) => toRecommendation(r, `Goes with your ${category.toLowerCase()}`)),
  ).slice(0, limit);
}

/**
 * A genuine step up: same category, better rated, and more expensive.
 *
 * Both conditions matter. "More expensive" alone is not an upsell, it is just a
 * bigger number; "better rated" alone is a cheaper recommendation the shopper
 * would rather have found first. Only offering something that is both keeps the
 * suggestion defensible.
 */
export async function upsellFrom(
  productId: string,
  category: string,
  priceMinor: number,
  limit = 2,
): Promise<Recommendation[]> {
  const rows = (await db.execute(sql`
    ${SELECT}
    FROM products p
    JOIN merchants m ON m.id = p.merchant_id
    JOIN LATERAL (
      SELECT v.* FROM product_variants v
      JOIN inventory i ON i.variant_id = v.id
      WHERE v.product_id = p.id AND v.active AND (i.quantity - i.reserved) > 0
        AND v.price_minor > ${priceMinor}
      ORDER BY v.price_minor ASC
      LIMIT 1
    ) v ON true
    WHERE p.status = 'active'
      AND p.id <> ${productId}
      AND p.category = ${category}
      AND p.rating_bp IS NOT NULL
      AND p.rating_bp >= (SELECT COALESCE(rating_bp, 0) FROM products WHERE id = ${productId})
    ORDER BY p.rating_bp DESC, v.price_minor ASC
    LIMIT ${limit * 6}
  `)) as unknown as Row[];

  return dedupe(rows.map((r) => toRecommendation(r, "A step up, rated higher"))).slice(0, limit);
}

export type Suggestions = {
  /** Things that go WITH what they chose. */
  crossSell: Recommendation[];
  /** A better version of what they chose. */
  upsell: Recommendation[];
};

/**
 * What to show once something is chosen.
 *
 * Cross-sell leads with real co-purchase, then falls back to complementary
 * categories. Similarity is deliberately NOT used here: it is the right answer
 * to "show me alternatives" and the wrong one to "what now?".
 */
export async function suggestionsFor(
  productId: string,
  limit = 4,
): Promise<Suggestions> {
  const [anchor] = (await db.execute(sql`
    SELECT p.title, p.category,
           (SELECT MIN(v.price_minor) FROM product_variants v WHERE v.product_id = p.id) AS price_minor
    FROM products p WHERE p.id = ${productId} LIMIT 1
  `)) as unknown as { title: string; category: string; price_minor: number }[];

  if (!anchor) return { crossSell: [], upsell: [] };
  const anchorTitle = anchor.title.toLowerCase().trim();

  const bought = await alsoBought(productId, limit);
  const complementary = await goesWith(productId, anchor.category, limit);

  const crossSell = dedupe([...bought, ...complementary])
    .filter((r) => r.title.toLowerCase().trim() !== anchorTitle)
    // Never cross-sell the same category — that is the bug this replaces.
    .filter((r) => r.category !== anchor.category)
    .slice(0, limit);

  const upsell = (await upsellFrom(productId, anchor.category, Number(anchor.price_minor)))
    .filter((r) => r.title.toLowerCase().trim() !== anchorTitle);

  return { crossSell, upsell };
}

/** Back-compat: a flat list, cross-sell first. */
export async function recommendationsFor(
  productId: string,
  limit = 4,
): Promise<Recommendation[]> {
  const { crossSell, upsell } = await suggestionsFor(productId, limit);
  return [...crossSell, ...upsell].slice(0, limit);
}
