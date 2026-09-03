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
  /**
   * Constraints on the 1–5 rated features, e.g. "waterproof but breathable"
   * becomes waterResistance >= 4 AND breathability >= 4.
   *
   * These are FILTERS, not similarity. A single embedding cannot represent
   * "at least 4 out of 5", and it puts "waterproof but NOT breathable" almost
   * exactly where it puts "waterproof AND breathable" — measured here as
   * trade-off queries scoring 0.338 against 0.629 for single attributes, on the
   * same corpus and embedder. The gap is logic, not semantics, so it is
   * answered with a predicate rather than a bigger model.
   */
  qualityConstraints?: QualityConstraint[];
  limit?: number;
};

export type QualityConstraint = {
  /** A key inside `products.attributes.qualities`, e.g. "waterResistance". */
  key: string;
  op: "gte" | "lte";
  /** 1–5. */
  value: number;
};

export type RejectionReason =
  | "attribute_mismatch"
  | "out_of_stock"
  | "over_budget"
  | "under_budget"
  | "category_mismatch"
  | "brand_mismatch"
  | "quality_mismatch"
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
  /**
   * What sort of product this was.
   *
   * Carried so a caller can tell WHAT was filtered out, not just that
   * something was. A product rejected for its colour is still the kind of
   * thing the shopper was shopping for, and `findAlternatives` uses exactly
   * that to keep a substitute in the right category.
   */
  category: string;
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

/**
 * How much the OR fallback counts against a precise AND match.
 *
 * It is a rescue, not an equal: ORing a sentence's terms lets a broad word like
 * "shoes" match a third of the catalogue, and at full weight that noise cost
 * measurable recall on queries that describe a need without naming a product
 * ("my feet get unbearably hot"). Discounted, it still rescues the queries that
 * matched nothing at all while leaving the ranking to the embedding where the
 * lexical signal is genuinely weak.
 */
const LEX_FALLBACK_CONFIDENCE = 0.4;
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

/**
 * SQL for the rated-feature constraints, or empty when there are none.
 *
 * A product that does not publish the quality is EXCLUDED, deliberately. Every
 * product carries scores for the qualities its category is measured on, so a
 * missing key means the quality does not apply — a t-shirt has no water
 * resistance rating because the question is meaningless for it, not because it
 * is unrated. Tolerating NULL let every such product through the filter and
 * kept trade-off recall pinned at 0.438: "packability <= 2" matched every
 * garment that had never been scored for packability.
 *
 * If the constraint turns out to be too tight, the RELAXATION path drops it and
 * says so — which is the honest way to widen, rather than never narrowing.
 */
function buildQualityFilter(constraints: QualityConstraint[] | undefined) {
  if (!constraints?.length) return sql``;

  const clauses = constraints.map((c) => {
    const path = sql`(attributes->'qualities'->>${c.key})::int`;
    return c.op === "gte" ? sql`${path} >= ${c.value}` : sql`${path} <= ${c.value}`;
  });

  return sql` AND ${sql.join(clauses, sql` AND `)}`;
}

/**
 * Free text as a lexical query that ORs its terms, ranked by how many hit.
 *
 * `websearch_to_tsquery` ANDs everything, which quietly killed the entire
 * lexical leg for conversational input: "shoes I can play tennis in" required
 * shoes AND play AND tennis AND... and matched **0 of 503** documents, while
 * "tennis" alone matches exactly the 13 court shoes. Every natural-language
 * query — which is the primary way anyone talks to this agent — was therefore
 * ranked by the embedding alone, and the weighted A/B tsvector that exists to
 * make a title or tag match beat a body match was doing nothing at all.
 *
 * OR is the right semantics BECAUSE of `ts_rank`: a document matching "tennis"
 * and "shoes" outranks one matching only "shoes", so breadth of match becomes a
 * ranking signal instead of a precondition for appearing.
 *
 * Tokens are reduced to `[a-z0-9]+` before they reach `to_tsquery`, which unlike
 * the `websearch_` and `plainto_` forms parses operator syntax and would throw
 * on a stray `&`, `|` or quote in a shopper's sentence.
 */
const LEXICAL_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "you", "your", "can", "could",
  "would", "some", "something", "anything", "want", "need", "looking", "look",
  "buy", "get", "give", "show", "find", "have", "has", "are", "was", "were",
  "but", "not", "any", "all", "from", "into", "out", "who", "what", "which",
  "when", "where", "how", "please", "thanks", "good", "nice", "best", "very",
]);

function orTsQuery(text: string): string {
  const terms = (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((t) => t.length >= 3 && !LEXICAL_STOPWORDS.has(t));

  // Nothing usable left — a query of only stopwords must match nothing rather
  // than everything, so the vector leg decides on its own.
  const unique = [...new Set(terms)];
  return unique.length > 0 ? unique.join(" | ") : "zzzznomatchzzzz";
}

/** Recall stage: semantic + lexical, fused by Reciprocal Rank Fusion. */
async function recall(query: StructuredQuery, k: number): Promise<FusionRow[]> {
  const vector = await embedOne(query.text);
  const literal = JSON.stringify(vector);
  const lexical = orTsQuery(query.text);

  /*
   * Rated-feature constraints are a PRE-filter, not a post-filter.
   *
   * Applying them after recall only narrows the top-k that similarity already
   * chose, so a qualifying product that similarity ranked 80th is still lost —
   * measured as trade-off recall stalling at 0.438 when the predicate ran after
   * the fact. Pushing it into both recall legs means the k candidates are drawn
   * from products that already satisfy the constraint.
   */
  const qualityFilter = buildQualityFilter(query.qualityConstraints);

  const rows = await db.execute<FusionRow>(sql`
    WITH eligible AS (
      SELECT id FROM products WHERE status = 'active' ${qualityFilter}
    ),
    vec AS (
      SELECT cd.product_id,
             ROW_NUMBER() OVER (ORDER BY cd.embedding <=> ${literal}::vector) AS rank,
             1 - (cd.embedding <=> ${literal}::vector) AS score
      FROM catalog_documents cd
      JOIN eligible e ON e.id = cd.product_id
      WHERE cd.embedding IS NOT NULL
      ORDER BY cd.embedding <=> ${literal}::vector
      LIMIT ${k}
    ),
    /*
     * Precise first, broad only if precise found nothing.
     *
     * ANDing every term is the right lexical query when the shopper types
     * keywords, and the eval says so — forcing OR everywhere cost 0.011 recall
     * by letting a broad term like "shoes" drag two hundred loose matches into
     * the fusion. But AND is catastrophic for a sentence: "shoes I can play
     * tennis in" required all of those words together and matched 0 of 503, so
     * the lexical leg silently contributed NOTHING to every conversational
     * query, which is the main way anyone talks to this agent.
     *
     * The fallback keeps both behaviours honest. Precise queries are unchanged;
     * a sentence that would have matched nothing now falls back to OR, where
     * ts_rank turns breadth of match into a ranking signal rather than a
     * precondition.
     */
    lex_and AS (
      SELECT cd.product_id, ts_rank(cd.search_vector, q) AS score
      FROM catalog_documents cd
      JOIN eligible e ON e.id = cd.product_id,
           websearch_to_tsquery('english', ${query.text}) q
      WHERE cd.search_vector @@ q
      ORDER BY score DESC
      LIMIT ${k}
    ),
    lex_or AS (
      SELECT cd.product_id, ts_rank(cd.search_vector, q) AS score
      FROM catalog_documents cd
      JOIN eligible e ON e.id = cd.product_id,
           to_tsquery('english', ${lexical}) q
      WHERE cd.search_vector @@ q
        AND NOT EXISTS (SELECT 1 FROM lex_and)
      ORDER BY score DESC
      LIMIT ${k}
    ),
    lex AS (
      SELECT product_id, score, confidence,
             ROW_NUMBER() OVER (ORDER BY score DESC) AS rank
      FROM (
        SELECT product_id, score, 1.0 AS confidence FROM lex_and
        UNION ALL
        SELECT product_id, score, ${LEX_FALLBACK_CONFIDENCE} FROM lex_or
      ) merged
    )
    SELECT COALESCE(v.product_id, l.product_id) AS product_id,
           v.score AS vec_score,
           l.score AS lex_score,
           COALESCE(1.0 / (${RRF_K} + v.rank), 0)
             + COALESCE(l.confidence / (${RRF_K} + l.rank), 0) AS rrf
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

/** Reads the numeric feature ratings off a product row. */
function extractQualityScores(attributes: unknown): Record<string, number> {
  const raw = (attributes as Record<string, unknown> | null)?.qualities;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
}

function humanizeQualityKey(key: string): string {
  return key.replace(/([A-Z])/g, " $1").toLowerCase().trim();
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
        category: head.category,
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

    /*
     * Rated-feature constraints, applied as a predicate.
     *
     * Only what the shopper actually asked for reaches here (see
     * `qualityConstraints` on StructuredQuery). A product that does not publish
     * the quality at all is NOT rejected — absence of a rating is not evidence
     * of a bad one, and rejecting on it would quietly hide every hand-written
     * product from a feature search.
     */
    if (query.qualityConstraints?.length) {
      const scores = extractQualityScores(head.attributes);
      const failed = query.qualityConstraints.find((c) => {
        const score = scores[c.key];
        // Unrated for this quality means it does not apply — same rule as the
        // pre-filter, so the two stages cannot disagree.
        if (score === undefined) return true;
        return c.op === "gte" ? score < c.value : score > c.value;
      });

      if (failed) {
        const actual = scores[failed.key];
        reject(
          "quality_mismatch",
          `${humanizeQualityKey(failed.key)} is ${actual}/5, ` +
            `and you wanted ${failed.op === "gte" ? "at least" : "at most"} ${failed.value}/5.`,
        );
        continue;
      }
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
        category: candidate.category,
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
        category: candidate.category,
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
