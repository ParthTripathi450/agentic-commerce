import { sql } from "drizzle-orm";
import { db } from "@/db";
import { formatMoney } from "@/lib/money";
import { embedOne } from "@/server/ai/embeddings";

/**
 * Cross-merchant hybrid retrieval.
 *
 * No LLM runs here. Recall is semantic (pgvector) fused with lexical (Postgres
 * full-text) via Reciprocal Rank Fusion; the hard constraints — size, colour,
 * budget, stock, sale window, merchant allow/deny — are then applied as exact
 * filters against live data.
 *
 * Products that fail a constraint are not silently dropped: each one is
 * returned in `rejected` with the specific reason, which is what lets the agent
 * explain why the obvious cheap option wasn't chosen.
 */

export type StructuredQuery = {
  /** Natural-language text used for the semantic leg of retrieval. */
  text: string;
  category?: string | null;
  brand?: string | null;
  /** Variant axes that must match exactly, e.g. { color: "black", size: "10" }. */
  attributes?: Record<string, string>;
  priceMinMinor?: number | null;
  priceMaxMinor?: number | null;
  merchantSlugs?: string[];
  excludeMerchantIds?: string[];
  requireInStock?: boolean;
  limit?: number;
};

export type RejectionReason =
  | "attribute_mismatch"
  | "out_of_stock"
  | "over_budget"
  | "under_budget"
  | "category_mismatch"
  | "brand_mismatch"
  | "merchant_excluded"
  | "outside_sale_window"
  | "not_relevant";

export type Candidate = {
  productId: string;
  title: string;
  description: string;
  brand: string | null;
  category: string;
  attributes: Record<string, unknown>;
  imageUrls: string[];
  ratingBp: number | null;
  ratingCount: number;
  merchant: {
    id: string;
    slug: string;
    name: string;
    fulfillmentRateBp: number;
    avgDispatchHours: number;
  };
  policies: {
    returnWindowDays: number;
    returnsAccepted: boolean;
    standardDeliveryDays: number;
    flatShippingMinor: number;
    freeShippingAboveMinor: number | null;
  };
  /** The cheapest variant that satisfies every hard constraint. */
  variant: {
    id: string;
    sku: string;
    attributes: Record<string, string>;
    priceMinor: number;
    compareAtPriceMinor: number | null;
    currency: string;
    availableQuantity: number;
  };
  retrieval: { vectorScore: number; lexicalScore: number; rrf: number };
};

export type Rejected = {
  productId: string;
  title: string;
  merchantSlug: string;
  merchantName: string;
  reason: RejectionReason;
  detail: string;
  /** Cheapest price seen for this product, for "it was ₹X, over your budget". */
  observedPriceMinor?: number;
};

export type SearchResult = {
  candidates: Candidate[];
  rejected: Rejected[];
  stats: {
    recalled: number;
    considered: number;
    accepted: number;
    merchantsSearched: number;
    durationMs: number;
    /** Best semantic score seen, before any filtering. */
    topRelevance: number;
  };
  /**
   * True when nothing in the catalogue is close to what was asked for.
   * Callers must NOT relax constraints in this case — there is nothing to
   * relax toward, and widening the search only surfaces unrelated products.
   */
  noRelevantMatch: boolean;
};

const RRF_K = 60;
const DEFAULT_RECALL = 60;

/**
 * Relevance gate.
 *
 * Semantic recall always returns SOMETHING — ask for headphones and a yoga mat
 * still comes back, just with a low similarity. If relevance is merely a
 * weighted criterion, a barely-related but cheap, well-reviewed product can
 * out-score the thing actually asked for. It cannot: an irrelevant product is
 * not a candidate at any price.
 *
 * Kept relative to the best match rather than as a fixed threshold, because
 * absolute cosine similarity varies a lot with how a shopper phrases things.
 */
const RELEVANCE_RATIO = 0.55;
/** Absolute floor, so a query matching nothing well returns nothing. */
const RELEVANCE_FLOOR = 0.12;

/**
 * Below this, the catalogue simply does not stock what was asked for.
 *
 * Re-measured on the 503-product catalogue (`npm run eval:relevance-gate`):
 * clearly-unstocked queries score 0.199–0.294 (prescription medication, garden
 * shed, engagement ring, gaming laptop) while stocked ones reach 0.72–0.75.
 * 0.34 still sits in that gap.
 *
 * **The margin has narrowed, and honestly so.** Two things moved it:
 *
 *  1. A marketplace selling kitchen appliances and home textiles is genuinely
 *     nearer to "washing machine" (0.359) than one selling only shoes (0.307).
 *     That is the catalogue being more diverse, not the gate being wrong.
 *  2. Rendering quality scores into every document added shared phrasing, and
 *     shared phrasing pulls all embeddings toward a common centroid — measured
 *     at +27% similarity between two unrelated documents. It bought a large
 *     win (attribute recall@10 went 0.295 -> 0.629) at the cost of margin here.
 *
 * The consequence: near-miss household queries ("washing machine", "dishwasher
 * tablets" 0.375) now leak past the gate, and "noise cancelling headphones"
 * (0.373, genuinely stocked) sits among them — so no threshold separates those
 * two cases. The real fix is a stronger embedding model than 22M MiniLM, which
 * trades against the M1/no-heavy-local-compute constraint. Do NOT paper over it
 * by raising the threshold: that starts refusing products we actually sell.
 *
 * The point is to answer "we don't sell that" instead of offering the nearest
 * unrelated thing — an agent that returns a marble run for "electric guitar"
 * has hallucinated a result, even though retrieval worked exactly as designed.
 */
const MIN_TOP_RELEVANCE = 0.34;

type FusionRow = {
  product_id: string;
  vec_score: number | null;
  lex_score: number | null;
  rrf: number;
};

type DetailRow = {
  product_id: string;
  title: string;
  description: string;
  brand: string | null;
  category: string;
  attributes: Record<string, unknown>;
  image_urls: string[];
  rating_bp: number | null;
  rating_count: number;
  merchant_id: string;
  merchant_slug: string;
  merchant_name: string;
  fulfillment_rate_bp: number;
  avg_dispatch_hours: number;
  return_window_days: number | null;
  returns_accepted: boolean | null;
  standard_delivery_days: number | null;
  flat_shipping_minor: number | null;
  free_shipping_above_minor: number | null;
  variant_id: string;
  sku: string;
  variant_attributes: Record<string, string>;
  price_minor: number;
  compare_at_price_minor: number | null;
  currency: string;
  variant_active: boolean;
  available_quantity: number;
  in_sale_window: boolean;
};

/** Recall stage: semantic + lexical, fused by Reciprocal Rank Fusion. */
async function recall(query: StructuredQuery, k: number): Promise<FusionRow[]> {
  const vector = await embedOne(query.text);
  const literal = JSON.stringify(vector);

  const rows = await db.execute<FusionRow>(sql`
    WITH vec AS (
      SELECT product_id,
             ROW_NUMBER() OVER (ORDER BY embedding <=> ${literal}::vector) AS rank,
             1 - (embedding <=> ${literal}::vector) AS score
      FROM catalog_documents
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> ${literal}::vector
      LIMIT ${k}
    ),
    lex AS (
      SELECT cd.product_id,
             ROW_NUMBER() OVER (ORDER BY ts_rank(cd.search_vector, q) DESC) AS rank,
             ts_rank(cd.search_vector, q) AS score
      FROM catalog_documents cd, websearch_to_tsquery('english', ${query.text}) q
      WHERE cd.search_vector @@ q
      ORDER BY score DESC
      LIMIT ${k}
    )
    SELECT COALESCE(v.product_id, l.product_id) AS product_id,
           v.score AS vec_score,
           l.score AS lex_score,
           COALESCE(1.0 / (${RRF_K} + v.rank), 0) + COALESCE(1.0 / (${RRF_K} + l.rank), 0) AS rrf
    FROM vec v
    FULL OUTER JOIN lex l ON v.product_id = l.product_id
    ORDER BY rrf DESC
    LIMIT ${k}
  `);

  return rows as unknown as FusionRow[];
}

/** Loads every purchasable variant for the recalled products, with live stock. */
async function loadDetails(productIds: string[]): Promise<DetailRow[]> {
  if (productIds.length === 0) return [];
  const rows = await db.execute<DetailRow>(sql`
    SELECT
      p.id AS product_id, p.title, p.description, p.brand, p.category,
      p.attributes, p.image_urls, p.rating_bp, p.rating_count,
      m.id AS merchant_id, m.slug AS merchant_slug, m.name AS merchant_name,
      m.fulfillment_rate_bp, m.avg_dispatch_hours,
      mp.return_window_days, mp.returns_accepted, mp.standard_delivery_days,
      mp.flat_shipping_minor, mp.free_shipping_above_minor,
      v.id AS variant_id, v.sku, v.attributes AS variant_attributes,
      v.price_minor, v.compare_at_price_minor, v.currency, v.active AS variant_active,
      GREATEST(COALESCE(i.quantity, 0) - COALESCE(i.reserved, 0), 0) AS available_quantity,
      CASE
        WHEN NOT EXISTS (SELECT 1 FROM availability_windows aw WHERE aw.variant_id = v.id)
          THEN true
        ELSE EXISTS (
          SELECT 1 FROM availability_windows aw
          WHERE aw.variant_id = v.id
            AND aw.starts_at <= now()
            AND (aw.ends_at IS NULL OR aw.ends_at >= now())
        )
      END AS in_sale_window
    FROM products p
    JOIN merchants m ON m.id = p.merchant_id
    LEFT JOIN merchant_policies mp ON mp.merchant_id = m.id
    JOIN product_variants v ON v.product_id = p.id
    LEFT JOIN inventory i ON i.variant_id = v.id
    WHERE p.id IN (${sql.join(productIds.map((id) => sql`${id}`), sql`, `)})
      AND p.status = 'active'
      AND m.status = 'active'
  `);
  return rows as unknown as DetailRow[];
}

function attributesMatch(
  variantAttrs: Record<string, string>,
  required: Record<string, string>,
): boolean {
  return Object.entries(required).every(
    ([key, value]) =>
      String(variantAttrs[key] ?? "").toLowerCase() === String(value).toLowerCase(),
  );
}

export async function hybridSearch(query: StructuredQuery): Promise<SearchResult> {
  const startedAt = Date.now();
  const recallLimit = Math.max(query.limit ?? 10, DEFAULT_RECALL);

  const fused = await recall(query, recallLimit);
  const scoreByProduct = new Map(fused.map((f) => [f.product_id, f]));
  const rows = await loadDetails(fused.map((f) => f.product_id));

  const byProduct = new Map<string, DetailRow[]>();
  for (const row of rows) {
    const list = byProduct.get(row.product_id) ?? [];
    list.push(row);
    byProduct.set(row.product_id, list);
  }

  const candidates: Candidate[] = [];
  const rejected: Rejected[] = [];
  const merchantsSeen = new Set<string>();
  const required = query.attributes ?? {};

  /*
   * Relevance is judged on what RETRIEVAL found, before any hard filter runs.
   *
   * Otherwise a wrong filter looks identical to an empty catalogue: an inferred
   * category of "Activewear" for "yoga mat" removes every yoga mat, leaving
   * t-shirts scoring 0.27 — and the guard would report "we don't sell that"
   * when the real problem is a filter the shopper never asked for.
   *
   * Filters too tight  -> relax them and say so.
   * Nothing stocked    -> stop, and show nothing.
   */
  const bestRecalled = fused.reduce((max, row) => Math.max(max, Number(row.vec_score ?? 0)), 0);
  const stocksNothingLikeIt = bestRecalled > 0 && bestRecalled < MIN_TOP_RELEVANCE;

  for (const [productId, variants] of byProduct) {
    const head = variants[0];
    merchantsSeen.add(head.merchant_slug);

    const reject = (reason: RejectionReason, detail: string, price?: number) =>
      rejected.push({
        productId,
        title: head.title,
        merchantSlug: head.merchant_slug,
        merchantName: head.merchant_name,
        reason,
        detail,
        observedPriceMinor: price,
      });

    if (query.excludeMerchantIds?.includes(head.merchant_id)) {
      reject("merchant_excluded", `${head.merchant_name} is excluded by your preferences.`);
      continue;
    }
    if (query.merchantSlugs?.length && !query.merchantSlugs.includes(head.merchant_slug)) {
      reject("merchant_excluded", `${head.merchant_name} is outside the merchants you asked for.`);
      continue;
    }
    if (query.category && head.category.toLowerCase() !== query.category.toLowerCase()) {
      reject("category_mismatch", `Listed under ${head.category}, not ${query.category}.`);
      continue;
    }
    if (query.brand && (head.brand ?? "").toLowerCase() !== query.brand.toLowerCase()) {
      reject("brand_mismatch", `Made by ${head.brand ?? "an unlisted brand"}, not ${query.brand}.`);
      continue;
    }

    // Narrow to variants satisfying the requested attributes.
    const active = variants.filter((v) => v.variant_active);
    const matching = active.filter((v) => attributesMatch(v.variant_attributes, required));
    if (matching.length === 0) {
      const wanted = Object.entries(required)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ");
      reject(
        "attribute_mismatch",
        wanted ? `Not offered in ${wanted}.` : "No purchasable variant available.",
        active.length ? Math.min(...active.map((v) => v.price_minor)) : undefined,
      );
      continue;
    }

    const sellable = matching.filter((v) => v.in_sale_window);
    if (sellable.length === 0) {
      reject("outside_sale_window", "Not on sale in the current availability window.");
      continue;
    }

    const withinBudget = sellable.filter((v) => {
      if (query.priceMaxMinor != null && v.price_minor > query.priceMaxMinor) return false;
      if (query.priceMinMinor != null && v.price_minor < query.priceMinMinor) return false;
      return true;
    });
    if (withinBudget.length === 0) {
      const cheapest = Math.min(...sellable.map((v) => v.price_minor));
      const overBudget = query.priceMaxMinor != null && cheapest > query.priceMaxMinor;
      reject(
        overBudget ? "over_budget" : "under_budget",
        overBudget
          ? `Cheapest matching option is ${formatMoney(cheapest)}, above your budget.`
          : `Priced below the minimum you set.`,
        cheapest,
      );
      continue;
    }

    const inStock =
      query.requireInStock === false
        ? withinBudget
        : withinBudget.filter((v) => v.available_quantity > 0);
    if (inStock.length === 0) {
      reject(
        "out_of_stock",
        "Matches what you asked for, but is out of stock right now.",
        Math.min(...withinBudget.map((v) => v.price_minor)),
      );
      continue;
    }

    // Cheapest qualifying variant represents the product.
    const best = inStock.reduce((a, b) => (b.price_minor < a.price_minor ? b : a));
    const scores = scoreByProduct.get(productId);

    candidates.push({
      productId,
      title: head.title,
      description: head.description,
      brand: head.brand,
      category: head.category,
      attributes: head.attributes,
      imageUrls: head.image_urls ?? [],
      ratingBp: head.rating_bp,
      ratingCount: head.rating_count,
      merchant: {
        id: head.merchant_id,
        slug: head.merchant_slug,
        name: head.merchant_name,
        fulfillmentRateBp: head.fulfillment_rate_bp,
        avgDispatchHours: head.avg_dispatch_hours,
      },
      policies: {
        returnWindowDays: head.return_window_days ?? 0,
        returnsAccepted: head.returns_accepted ?? false,
        standardDeliveryDays: head.standard_delivery_days ?? 7,
        flatShippingMinor: head.flat_shipping_minor ?? 0,
        freeShippingAboveMinor: head.free_shipping_above_minor,
      },
      variant: {
        id: best.variant_id,
        sku: best.sku,
        attributes: best.variant_attributes,
        priceMinor: best.price_minor,
        compareAtPriceMinor: best.compare_at_price_minor,
        currency: best.currency,
        availableQuantity: best.available_quantity,
      },
      retrieval: {
        vectorScore: Number(scores?.vec_score ?? 0),
        lexicalScore: Number(scores?.lex_score ?? 0),
        rrf: Number(scores?.rrf ?? 0),
      },
    });
  }

  candidates.sort((a, b) => b.retrieval.rrf - a.retrieval.rrf);

  const topVectorScore = candidates.reduce((max, c) => Math.max(max, c.retrieval.vectorScore), 0);

  // Nothing in the catalogue resembles the request at all. Return nothing
  // rather than the nearest unrelated item, and tell the caller not to widen.
  if (stocksNothingLikeIt) {
    return {
      candidates: [],
      rejected: candidates.map((candidate) => ({
        productId: candidate.productId,
        title: candidate.title,
        merchantSlug: candidate.merchant.slug,
        merchantName: candidate.merchant.name,
        reason: "not_relevant" as const,
        detail: "Not what you asked for.",
        observedPriceMinor: candidate.variant.priceMinor,
      })),
      stats: {
        recalled: fused.length,
        considered: byProduct.size,
        accepted: 0,
        merchantsSearched: merchantsSeen.size,
        durationMs: Date.now() - startedAt,
        topRelevance: bestRecalled,
      },
      noRelevantMatch: true,
    };
  }

  const relevanceCutoff = Math.max(topVectorScore * RELEVANCE_RATIO, RELEVANCE_FLOOR);

  const relevant: Candidate[] = [];
  for (const candidate of candidates) {
    if (topVectorScore > 0 && candidate.retrieval.vectorScore < relevanceCutoff) {
      rejected.push({
        productId: candidate.productId,
        title: candidate.title,
        merchantSlug: candidate.merchant.slug,
        merchantName: candidate.merchant.name,
        reason: "not_relevant",
        detail: "Not close enough to what you described.",
        observedPriceMinor: candidate.variant.priceMinor,
      });
      continue;
    }
    relevant.push(candidate);
  }

  return {
    candidates: relevant,
    rejected,
    stats: {
      recalled: fused.length,
      considered: byProduct.size,
      accepted: relevant.length,
      merchantsSearched: merchantsSeen.size,
      durationMs: Date.now() - startedAt,
      topRelevance: bestRecalled,
    },
    noRelevantMatch: false,
  };
}
