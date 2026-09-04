import { sql } from "drizzle-orm";
import { db } from "@/db";
import {
  affinityFor,
  DEFAULT_AXES,
  type AxisWeights,
  type TasteProfile,
} from "@/server/agents/customer/affinity";
import { buildKnowledgeBase, toTasteProfile } from "./knowledge";

/**
 * Does the taste profile actually predict what a shopper buys next?
 *
 * "Better suggestions" is not a claim anyone can check by looking at a page —
 * every recommender's output looks plausible, which is exactly the problem. So
 * this asks a question with a right answer: **hold back a shopper's most recent
 * purchase, build their profile from what was known BEFORE it, and see how
 * highly the thing they actually bought is ranked.**
 *
 * Three properties make the number worth trusting.
 *
 * **No leakage.** The profile is built `asOf` the held-out order, so the
 * purchase being predicted is not among the evidence used to predict it. This
 * is the entire reason `buildKnowledgeBase` takes a cutoff; without it the
 * score would be a tautology.
 *
 * **Baselines, or the number means nothing.** A recall@10 of 0.30 is
 * impressive against random and embarrassing against "show the bestsellers", so
 * both are computed on the identical candidate set and reported alongside. A
 * personalisation that cannot beat popularity is not personalisation.
 *
 * **The same scorer the app uses.** Ranking is `affinityFor`, exactly as
 * `/for-you` calls it. An eval that scored candidates its own way would measure
 * a system nobody ships.
 *
 * A caveat this harness cannot fix: these orders are GENERATED. Fitting weights
 * against them would learn the generator's habits, not human taste. The number
 * is a regression guard today and becomes a measure of quality the moment real
 * shoppers use it — which is the right order to build these in anyway.
 */

export type ShopperCase = {
  userId: string;
  /** The purchase being predicted, held out of the profile. */
  targetProductIds: string[];
  asOf: Date;
  /** Distinct products bought before the cutoff — the evidence available. */
  priorProducts: number;
};

export type EvalResult = {
  cases: number;
  skipped: number;
  candidates: number;
  affinity: Metrics;
  popularity: Metrics;
  random: Metrics;
};

export type Metrics = { recallAt10: number; recallAt20: number; mrr: number };

type Candidate = {
  productId: string;
  brand: string | null;
  category: string;
  merchantName: string;
  colour: string | null;
  priceMinor: number;
  qualities: Record<string, number> | null;
  unitsSold: number;
};

/**
 * Shoppers who have bought at least twice.
 *
 * One purchase is not a case: there is nothing to build a profile from, so a
 * miss would say nothing about the profile and a hit would be luck.
 */
export async function repeatShoppers(limit = 500): Promise<ShopperCase[]> {
  const rows = (await db.execute(sql`
    WITH paid AS (
      SELECT o.id, o.user_id, o.created_at
      FROM orders o
      JOIN users u ON u.id = o.user_id
      WHERE o.state IN ('paid','fulfilled')
        /*
         * Shoppers only.
         *
         * The review pool buys across the whole catalogue to entitle reviews —
         * sixty accounts with eighty orders each spanning half the categories —
         * and integration tests leave their own accounts behind. Neither is a
         * person with taste, and including them guaranteed an unlearnable task:
         * the first run of this eval was largely measuring review scaffolding.
         */
        AND u.email NOT LIKE '%@marketplace.reviews'
        AND u.email NOT LIKE '%@acp.test'
    ),
    ranked AS (
      SELECT user_id, id, created_at,
             ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS recency,
             COUNT(*) OVER (PARTITION BY user_id) AS orders
      FROM paid
    ),
    latest AS (
      SELECT user_id, id AS order_id, created_at FROM ranked WHERE recency = 1 AND orders >= 2
    )
    SELECT l.user_id, l.created_at,
           ARRAY_AGG(DISTINCT v.product_id) AS target_products,
           (
             SELECT COUNT(DISTINCT pv.product_id)
             FROM orders o2
             JOIN order_items oi2 ON oi2.order_id = o2.id
             JOIN product_variants pv ON pv.id = oi2.variant_id
             WHERE o2.user_id = l.user_id
               AND o2.state IN ('paid','fulfilled')
               AND o2.created_at < l.created_at
           ) AS prior_products
    FROM latest l
    JOIN order_items oi ON oi.order_id = l.order_id
    JOIN product_variants v ON v.id = oi.variant_id
    GROUP BY l.user_id, l.created_at
    LIMIT ${limit}
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    userId: String(r.user_id),
    targetProductIds: (r.target_products as string[]) ?? [],
    asOf: new Date(String(r.created_at)),
    priorProducts: Number(r.prior_products ?? 0),
  }));
}

/** Every product a suggestion could be drawn from, scored the way /for-you scores. */
async function loadCandidates(): Promise<Candidate[]> {
  const rows = (await db.execute(sql`
    WITH sold AS (
      SELECT v.product_id, SUM(oi.quantity) AS units
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN product_variants v ON v.id = oi.variant_id
      WHERE o.state IN ('paid','fulfilled')
      GROUP BY v.product_id
    ),
    cheapest AS (
      SELECT DISTINCT ON (v.product_id)
             v.product_id, v.price_minor, v.attributes->>'color' AS colour
      FROM product_variants v
      WHERE v.active = true
      ORDER BY v.product_id, v.price_minor ASC
    )
    SELECT p.id, p.brand, p.category, p.attributes, m.name AS merchant_name,
           c.price_minor, c.colour, COALESCE(s.units, 0) AS units
    FROM products p
    JOIN merchants m ON m.id = p.merchant_id
    JOIN cheapest c ON c.product_id = p.id
    LEFT JOIN sold s ON s.product_id = p.id
    WHERE p.status = 'active'
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    productId: String(r.id),
    brand: r.brand ? String(r.brand) : null,
    category: String(r.category),
    merchantName: String(r.merchant_name),
    colour: r.colour ? String(r.colour) : null,
    priceMinor: Number(r.price_minor),
    qualities: (r.attributes as { qualities?: Record<string, number> })?.qualities ?? null,
    unitsSold: Number(r.units ?? 0),
  }));
}

/** Products this shopper already owned before the cutoff — excluded, as /for-you does. */
async function ownedBefore(userId: string, asOf: Date): Promise<Set<string>> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT v.product_id
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN product_variants v ON v.id = oi.variant_id
    WHERE o.user_id = ${userId}
      AND o.state IN ('paid','fulfilled')
      AND o.created_at < ${asOf.toISOString()}
  `)) as unknown as { product_id: string }[];
  return new Set(rows.map((r) => r.product_id));
}

/** Where the held-out purchase landed, given a ranking. */
function scoreRanking(ranked: string[], targets: Set<string>): { rank: number | null } {
  for (let i = 0; i < ranked.length; i++) {
    if (targets.has(ranked[i])) return { rank: i + 1 };
  }
  return { rank: null };
}

function summarise(ranks: (number | null)[]): Metrics {
  const found = ranks.filter((r): r is number => r != null);
  const hits = (k: number) => found.filter((r) => r <= k).length / Math.max(ranks.length, 1);
  const mrr = found.reduce((sum, r) => sum + 1 / r, 0) / Math.max(ranks.length, 1);
  return {
    recallAt10: Number(hits(10).toFixed(3)),
    recallAt20: Number(hits(20).toFixed(3)),
    mrr: Number(mrr.toFixed(3)),
  };
}

export async function evaluateForYou(
  options: {
    limit?: number;
    /** Axis weights to score with. Defaults to the ones the app ships. */
    axes?: AxisWeights;
    /** Restrict to these shoppers — used for cross-validation folds. */
    only?: Set<string>;
    /** Pre-loaded so a weight search does not re-query per candidate set. */
    preloaded?: PreparedCases;
  } = {},
): Promise<EvalResult> {
  const axes = options.axes ?? DEFAULT_AXES;
  const prepared = options.preloaded ?? (await prepareCases(options.limit ?? 500));
  const cases = options.only
    ? prepared.cases.filter((c) => options.only!.has(c.userId))
    : prepared.cases;
  const catalogue = prepared.catalogue;

  const affinityRanks: (number | null)[] = [];
  const popularityRanks: (number | null)[] = [];
  const randomRanks: (number | null)[] = [];
  let skipped = 0;
  let poolSize = 0;

  for (const shopperCase of cases) {
    const taste = prepared.tastes.get(shopperCase.userId);
    // Nothing known before the cutoff means nothing to predict from; scoring it
    // would measure the catalogue's popularity, not the profile.
    if (!taste) {
      skipped++;
      continue;
    }

    const owned = prepared.owned.get(shopperCase.userId) ?? new Set<string>();
    const targets = new Set(shopperCase.targetProductIds);
    const pool = catalogue.filter((c) => !owned.has(c.productId) || targets.has(c.productId));

    // A target the shopper had already bought before is not a prediction task.
    if (!pool.some((c) => targets.has(c.productId))) {
      skipped++;
      continue;
    }
    poolSize = pool.length;

    const byAffinity = [...pool]
      .map((c) => ({
        id: c.productId,
        score: affinityFor(
          {
            brand: c.brand,
            category: c.category,
            merchantName: c.merchantName,
            colour: c.colour,
            priceMinor: c.priceMinor,
            qualities: c.qualities,
          },
          taste,
          axes,
        ).normalized,
      }))
      .sort((a, b) => b.score - a.score)
      .map((c) => c.id);

    const byPopularity = [...pool]
      .sort((a, b) => b.unitsSold - a.unitsSold)
      .map((c) => c.productId);

    affinityRanks.push(scoreRanking(byAffinity, targets).rank);
    popularityRanks.push(scoreRanking(byPopularity, targets).rank);
    // Deterministic pseudo-shuffle, so the baseline is reproducible run to run.
    randomRanks.push(
      scoreRanking(
        [...pool]
          .map((c) => ({ id: c.productId, k: hash(`${shopperCase.userId}:${c.productId}`) }))
          .sort((a, b) => a.k - b.k)
          .map((c) => c.id),
        targets,
      ).rank,
    );
  }

  return {
    cases: affinityRanks.length,
    skipped,
    candidates: poolSize,
    affinity: summarise(affinityRanks),
    popularity: summarise(popularityRanks),
    random: summarise(randomRanks),
  };
}

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Everything the eval needs, loaded once.
 *
 * A weight search calls `evaluateForYou` hundreds of times, and rebuilding
 * every profile from the database on each pass would make the search take
 * minutes instead of seconds for no different answer — the profiles do not
 * depend on the axis weights being searched.
 */
export type PreparedCases = {
  cases: ShopperCase[];
  catalogue: Candidate[];
  tastes: Map<string, TasteProfile>;
  owned: Map<string, Set<string>>;
};

export async function prepareCases(limit = 500): Promise<PreparedCases> {
  const cases = await repeatShoppers(limit);
  const catalogue = await loadCandidates();
  const tastes = new Map<string, TasteProfile>();
  const owned = new Map<string, Set<string>>();

  for (const shopperCase of cases) {
    const knowledge = await buildKnowledgeBase(shopperCase.userId, { asOf: shopperCase.asOf });
    if (!knowledge.isEmpty) tastes.set(shopperCase.userId, toTasteProfile(knowledge));
    owned.set(shopperCase.userId, await ownedBefore(shopperCase.userId, shopperCase.asOf));
  }

  return { cases, catalogue, tastes, owned };
}
