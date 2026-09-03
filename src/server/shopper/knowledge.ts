import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { TasteProfile } from "@/server/agents/customer/affinity";

/**
 * What we have learned about one shopper, derived entirely from what they did.
 *
 * Nothing here is declared by the shopper and nothing is invented by a model —
 * every line is an aggregate over their own orders, reviews, baskets and
 * browsing, so each preference can name the evidence behind it. That is the
 * whole design constraint: a profile a shopper cannot see the reasoning for is
 * one they cannot correct, and one the agent should not be trusted to act on.
 *
 * **Actions are weighted by how much they cost to take.** Paying for something
 * is the strongest statement of preference there is; opening a product page is
 * nearly free and says correspondingly little. So the ladder runs
 * review → purchase → basket → browse, and a bad review outweighs a purchase
 * because it is the shopper correcting a decision they already made — the one
 * signal that is explicitly about being wrong.
 *
 * **Preferences are a ranking nudge, never a filter.** A shopper who has bought
 * four pairs of running shoes has not asked to be shown only running shoes, and
 * turning "likes Aeris" into a hard `WHERE brand = 'Aeris'` would hide the
 * catalogue behind their own history — the same failure as §8.8, where a
 * guessed category became a filter and buried every yoga mat. This module
 * returns scores; `ranker.ts` folds them into a weight. Nothing here narrows
 * what is retrieved.
 */

/** How much each kind of action counts, before recency decay. */
const WEIGHTS = {
  /** They paid. The strongest ordinary evidence of a preference. */
  purchase: 4,
  /** They went back and said it was good, unprompted. */
  praised: 5,
  /**
   * They said it was bad. Heavier than a purchase in the opposite direction:
   * a poor review is the shopper telling us the purchase signal was WRONG, and
   * if it did not outweigh it, buying-then-hating would still read as a like.
   */
  panned: -6,
  /** Wanted it enough to put it in a basket, not enough to pay. */
  basket: 2,
  /** Chose it, then changed their mind before paying. */
  canceled: -2,
  /** Looked. Deliberately the weakest — most browsing means nothing. */
  browse: 1,
} as const;

/**
 * Half-life for recency, in days.
 *
 * Taste moves. Without decay a shopper is defined forever by their first
 * fortnight, and the profile becomes least accurate for the people who use the
 * marketplace most. 120 days keeps a season's worth of evidence dominant while
 * letting a year-old habit fade rather than vanish.
 */
const DECAY_DAYS = 120;

/** A review at or above this is praise; at or below `PANNED_BP`, a complaint. */
const PRAISED_BP = 4000;
const PANNED_BP = 2500;

/** Below this absolute score a preference is noise and is not reported. */
const MIN_SCORE = 1.5;

export type Preference = {
  value: string;
  /** Net weighted score. Positive is a like, negative a dislike. */
  score: number;
  /** Distinct products behind it — one product cannot make a pattern. */
  products: number;
  confidence: "strong" | "moderate" | "weak";
};

export type KnowledgeBase = {
  userId: string;
  likes: {
    categories: Preference[];
    brands: Preference[];
    qualities: Preference[];
    colours: Preference[];
    sizes: Preference[];
    merchants: Preference[];
  };
  dislikes: {
    categories: Preference[];
    brands: Preference[];
    qualities: Preference[];
  };
  /** What they actually spend, from paid orders only. */
  budget: { medianMinor: number; p25Minor: number; p75Minor: number; orders: number } | null;
  /** Recent searches, most recent first — context, not a preference. */
  recentSearches: string[];
  evidence: { purchases: number; reviews: number; baskets: number; browsed: number };
  /** True when there is too little history to say anything useful. */
  isEmpty: boolean;
};

/**
 * Everything the shopper has done, in one shape.
 *
 * Each row is (weight, product, its category/brand/merchant/price, and the
 * variant they chose). Recency decay is applied here so every axis downstream
 * inherits it and none can forget to.
 */
function signalsCte(userId: string) {
  const decay = sql`exp(-EXTRACT(EPOCH FROM (now() - occurred_at)) / 86400.0 / ${DECAY_DAYS})`;
  return sql`
    raw AS (
      -- Paid for it.
      SELECT ${WEIGHTS.purchase}::numeric AS w, v.product_id, v.attributes AS variant_attrs,
             oi.unit_price_minor AS price_minor, o.created_at AS occurred_at,
             'purchase' AS source
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN product_variants v ON v.id = oi.variant_id
      WHERE o.user_id = ${userId} AND o.state IN ('paid','fulfilled')

      UNION ALL

      -- Chose it, then backed out before paying.
      SELECT ${WEIGHTS.canceled}::numeric, v.product_id, v.attributes,
             oi.unit_price_minor, o.created_at, 'canceled'
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN product_variants v ON v.id = oi.variant_id
      WHERE o.user_id = ${userId} AND o.state = 'canceled'

      UNION ALL

      -- Went back and rated it. Neutral reviews (2.5–4★) are dropped rather
      -- than counted as a weak like: "it was fine" is not a preference.
      SELECT CASE WHEN r.rating_bp >= ${PRAISED_BP} THEN ${WEIGHTS.praised}::numeric
                  ELSE ${WEIGHTS.panned}::numeric END,
             r.product_id, '{}'::jsonb, NULL, r.created_at,
             CASE WHEN r.rating_bp >= ${PRAISED_BP} THEN 'praised' ELSE 'panned' END
      FROM product_reviews r
      WHERE r.user_id = ${userId}
        AND (r.rating_bp >= ${PRAISED_BP} OR r.rating_bp <= ${PANNED_BP})

      UNION ALL

      -- In a basket they never checked out. A basket that DID convert is
      -- already counted as a purchase above; counting it twice would let one
      -- decision outvote two.
      SELECT ${WEIGHTS.basket}::numeric, v.product_id, v.attributes,
             ci.unit_price_minor, ci.created_at, 'basket'
      FROM cart_items ci
      JOIN carts c ON c.id = ci.cart_id
      JOIN product_variants v ON v.id = ci.variant_id
      WHERE c.user_id = ${userId} AND c.status <> 'converted'

      UNION ALL

      -- Looked at it, or filtered for it.
      SELECT ${WEIGHTS.browse}::numeric, s.product_id, '{}'::jsonb,
             s.price_minor, s.created_at, 'browse'
      FROM shopper_signals s
      WHERE s.user_id = ${userId} AND s.product_id IS NOT NULL
    ),
    signals AS (
      SELECT raw.w * ${decay} AS weight,
             raw.w AS raw_weight,
             raw.source,
             raw.product_id,
             raw.variant_attrs,
             raw.price_minor,
             p.category, p.brand, p.attributes AS product_attrs,
             m.id AS merchant_id, m.name AS merchant_name
      FROM raw
      JOIN products p ON p.id = raw.product_id
      JOIN merchants m ON m.id = p.merchant_id
    )`;
}

export async function buildKnowledgeBase(userId: string): Promise<KnowledgeBase> {
  const [axisRows, budgetRows, searchRows, evidenceRows] = await Promise.all([
    // One long-format result: (axis, value, score, products). Aggregating each
    // axis in SQL rather than pulling every signal into JS keeps this one round
    // trip whether the shopper has ten actions or ten thousand.
    db.execute<Record<string, unknown>>(sql`
      WITH ${signalsCte(userId)}
      SELECT 'category' AS axis, category AS value,
             SUM(weight) AS score, COUNT(DISTINCT product_id) AS products
      FROM signals WHERE category IS NOT NULL GROUP BY category

      UNION ALL
      SELECT 'brand', brand, SUM(weight), COUNT(DISTINCT product_id)
      FROM signals WHERE brand IS NOT NULL GROUP BY brand

      UNION ALL
      SELECT 'merchant', merchant_name, SUM(weight), COUNT(DISTINCT product_id)
      FROM signals GROUP BY merchant_name

      UNION ALL
      SELECT 'colour', INITCAP(variant_attrs->>'color'), SUM(weight), COUNT(DISTINCT product_id)
      FROM signals WHERE variant_attrs->>'color' IS NOT NULL GROUP BY 2

      UNION ALL
      SELECT 'size', variant_attrs->>'size', SUM(weight), COUNT(DISTINCT product_id)
      FROM signals WHERE variant_attrs->>'size' IS NOT NULL GROUP BY 2

      -- Qualities are what a preference is ABOUT: "likes breathable things" is
      -- portable across categories in a way "likes Running Shoes" is not, so
      -- it is the part of the profile that can help with a first-time query.
      -- Only qualities the product genuinely scores well on count; carrying a
      -- 2/5 would record a shopper as liking the thing they put up with.
      UNION ALL
      SELECT 'quality', q.key, SUM(signals.weight), COUNT(DISTINCT product_id)
      FROM signals,
           LATERAL jsonb_each_text(COALESCE(product_attrs->'qualities', '{}'::jsonb)) AS q(key, val)
      WHERE q.val ~ '^[0-9]+$' AND q.val::int >= 4
      GROUP BY q.key
    `),
    db.execute<Record<string, unknown>>(sql`
      SELECT percentile_disc(0.25) WITHIN GROUP (ORDER BY oi.unit_price_minor) AS p25,
             percentile_disc(0.50) WITHIN GROUP (ORDER BY oi.unit_price_minor) AS p50,
             percentile_disc(0.75) WITHIN GROUP (ORDER BY oi.unit_price_minor) AS p75,
             COUNT(DISTINCT o.id) AS orders
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.user_id = ${userId} AND o.state IN ('paid','fulfilled')
    `),
    db.execute<Record<string, unknown>>(sql`
      SELECT DISTINCT ON (lower(query)) query, created_at
      FROM shopper_signals
      WHERE user_id = ${userId} AND kind = 'search' AND query IS NOT NULL AND query <> ''
      ORDER BY lower(query), created_at DESC
    `),
    db.execute<Record<string, unknown>>(sql`
      WITH ${signalsCte(userId)}
      SELECT source, COUNT(*) AS n FROM signals GROUP BY source
    `),
  ]);

  const axes = axisRows as unknown as Record<string, unknown>[];
  const byAxis = (axis: string, direction: 1 | -1) =>
    axes
      .filter((r) => r.axis === axis && r.value != null)
      .map((r) => toPreference(r))
      .filter((p) => direction * p.score >= MIN_SCORE)
      .sort((a, b) => direction * (b.score - a.score))
      .slice(0, 8);

  const budget = (budgetRows as unknown as Record<string, unknown>[])[0] ?? {};
  const orders = Number(budget.orders ?? 0);

  const counts = Object.fromEntries(
    (evidenceRows as unknown as Record<string, unknown>[]).map((r) => [
      String(r.source),
      Number(r.n),
    ]),
  );
  const evidence = {
    purchases: counts.purchase ?? 0,
    reviews: (counts.praised ?? 0) + (counts.panned ?? 0),
    baskets: counts.basket ?? 0,
    browsed: counts.browse ?? 0,
  };

  const likes = {
    categories: byAxis("category", 1),
    brands: byAxis("brand", 1),
    qualities: byAxis("quality", 1),
    colours: byAxis("colour", 1),
    sizes: byAxis("size", 1),
    merchants: byAxis("merchant", 1),
  };
  const dislikes = {
    categories: byAxis("category", -1),
    brands: byAxis("brand", -1),
    qualities: byAxis("quality", -1),
  };

  return {
    userId,
    likes,
    dislikes,
    budget:
      orders > 0
        ? {
            medianMinor: Number(budget.p50 ?? 0),
            p25Minor: Number(budget.p25 ?? 0),
            p75Minor: Number(budget.p75 ?? 0),
            orders,
          }
        : null,
    recentSearches: (searchRows as unknown as Record<string, unknown>[])
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 8)
      .map((r) => String(r.query)),
    evidence,
    isEmpty:
      Object.values(likes).every((list) => list.length === 0) &&
      Object.values(dislikes).every((list) => list.length === 0),
  };
}

/**
 * Confidence is about breadth, not magnitude.
 *
 * Ten signals from one product is one opinion recorded ten times; three
 * products agreeing is a pattern. So the product count gates the label, and a
 * single-product preference can never read as strong however heavily it scores.
 */
function toPreference(row: Record<string, unknown>): Preference {
  const score = Number(row.score ?? 0);
  const products = Number(row.products ?? 0);
  const magnitude = Math.abs(score);

  const confidence: Preference["confidence"] =
    products >= 3 && magnitude >= 8 ? "strong" : products >= 2 && magnitude >= 4 ? "moderate" : "weak";

  return { value: String(row.value), score: Number(score.toFixed(2)), products, confidence };
}

/**
 * The profile as a handful of plain sentences, for the agent's prompt.
 *
 * The model gets prose, never scores — the same rule `explain.ts` follows. A
 * model handed "brand Aeris: 12.4" will quote the number at the shopper as if
 * it meant something to them, and will start doing arithmetic on a figure whose
 * scale is arbitrary. It also gets only the confident half: an uncertain guess
 * stated as fact is worse than saying nothing, because the shopper then has to
 * correct it.
 */
export function describeKnowledge(kb: KnowledgeBase): string[] {
  const lines: string[] = [];
  const names = (list: Preference[], min: Preference["confidence"] = "moderate") =>
    list
      .filter((p) => (min === "weak" ? true : p.confidence !== "weak"))
      .map((p) => p.value);

  const say = (label: string, list: string[]) => {
    if (list.length > 0) lines.push(`${label}: ${list.slice(0, 4).join(", ")}.`);
  };

  say("Has bought and liked", names(kb.likes.categories));
  say("Tends to choose these brands", names(kb.likes.brands));
  say("Values these qualities", names(kb.likes.qualities));
  say("Usually picks these colours", names(kb.likes.colours));
  say("Has not got on with", names(kb.dislikes.brands, "weak"));
  say("Has been disappointed by", names(kb.dislikes.categories, "weak"));

  const sizes = names(kb.likes.sizes, "weak");
  if (sizes.length > 0) {
    // Sizes are the one part of the profile worth stating even on thin
    // evidence: asking someone their shoe size for the fourth time is the
    // failure this whole feature exists to avoid.
    lines.push(`Has previously ordered size ${sizes.slice(0, 3).join(" or ")}.`);
  }

  if (kb.budget && kb.budget.orders >= 2) {
    lines.push(
      `Typically spends around ${rupees(kb.budget.medianMinor)} per item, ` +
        `usually between ${rupees(kb.budget.p25Minor)} and ${rupees(kb.budget.p75Minor)}.`,
    );
  }

  if (kb.recentSearches.length > 0) {
    lines.push(`Recently searched for: ${kb.recentSearches.slice(0, 4).join("; ")}.`);
  }

  return lines;
}

function rupees(minor: number): string {
  return `₹${Math.round(minor / 100).toLocaleString("en-IN")}`;
}

/**
 * The knowledge base reduced to the numbers the ranker needs.
 *
 * Scores are rescaled against the strongest preference on each axis rather than
 * used raw. Raw sums grow without bound as a shopper's history grows, so a
 * long-standing customer's affinity criterion would slowly drown every other
 * criterion — the personal nudge has to stay a nudge for someone on their
 * hundredth order as much as their third.
 */
export function toTasteProfile(kb: KnowledgeBase): TasteProfile {
  const scale = (list: Preference[], floor: Preference["confidence"] = "weak") => {
    const kept = list.filter((p) =>
      floor === "weak" ? true : p.confidence !== "weak",
    );
    const peak = Math.max(...kept.map((p) => Math.abs(p.score)), 1);
    return Object.fromEntries(
      kept.map((p) => [p.value.trim().toLowerCase(), Math.min(1, Math.abs(p.score) / peak)]),
    );
  };

  return {
    // Brand and category drive the biggest reorderings, so they are held to
    // real evidence; colour and quality are gentler and may run on less.
    brands: scale(kb.likes.brands, "moderate"),
    categories: scale(kb.likes.categories, "moderate"),
    merchants: scale(kb.likes.merchants, "moderate"),
    qualities: scale(kb.likes.qualities),
    colours: scale(kb.likes.colours),
    dislikedBrands: scale(kb.dislikes.brands),
    dislikedCategories: scale(kb.dislikes.categories),
    budget: kb.budget ? { p25Minor: kb.budget.p25Minor, p75Minor: kb.budget.p75Minor } : null,
  };
}

/** Convenience for the agent path: build the profile in one call. */
export async function getTasteProfile(userId: string): Promise<TasteProfile> {
  return toTasteProfile(await buildKnowledgeBase(userId));
}
