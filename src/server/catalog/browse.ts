import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  PAGE_SIZE,
  type BrowseQuery,
  type BrowseResult,
  type BrowseSort,
} from "@/lib/browse";

/**
 * The catalogue as a browsable list — deliberately NOT the agent's search.
 *
 * They answer different questions. The agent answers "what should I buy?", so
 * it ranks semantically, applies a relevance gate and refuses when the
 * catalogue does not stock the kind of thing asked for. Browse answers "show me
 * everything, and let me narrow it", so it must be exhaustive, exactly
 * countable and stably paginated — page 3 has to hold still while you read it.
 *
 * That rules out the embedding path here: cosine similarity has no honest
 * notion of "how many match", and every product is similar to every query to
 * some degree, so there is nothing to count and no natural end to the list. So
 * browse is SQL only — no embedding call, no LLM call, no relevance gate. A
 * query that matches nothing correctly shows nothing; browse never claims a
 * match, so it needs no anti-hallucination gate.
 *
 * Text matching reuses the weighted `search_vector` that already exists for
 * lexical recall (title and tags at weight A, body at B), widened with a prefix
 * ILIKE. Full-text stemming alone matches "shoes" to "shoe" but not "vel" to
 * "Velocity", and a browse box is typed into a character at a time.
 */

export type {
  BrowseSort,
  BrowseQuery,
  BrowseItem,
  BrowseResult,
  FacetCount,
  PriceBand,
} from "@/lib/browse";

/**
 * The one buyable variant a product is listed and priced by.
 *
 * Price filters must bite on the price actually shown, or "under ₹2,000"
 * returns a product whose cheapest buyable variant is ₹5,000 — technically it
 * has a cheap variant, but not one anybody can put in a basket.
 */
function buyableCte(inStockOnly: boolean): SQL {
  const stockFilter = inStockOnly
    ? sql`AND GREATEST(i.quantity - i.reserved, 0) > 0`
    : sql``;
  return sql`
    buyable AS (
      SELECT DISTINCT ON (v.product_id)
             v.product_id,
             v.id AS variant_id,
             v.price_minor,
             v.compare_at_price_minor,
             v.currency,
             v.image_url,
             GREATEST(i.quantity - i.reserved, 0) > 0 AS in_stock
      FROM product_variants v
      JOIN inventory i ON i.variant_id = v.id
      WHERE v.active = true ${stockFilter}
      ORDER BY v.product_id,
               (GREATEST(i.quantity - i.reserved, 0) > 0) DESC,
               v.price_minor ASC
    )`;
}

function textPredicate(q: string | undefined): { join: SQL; where: SQL; rank: SQL } {
  if (!q) {
    return { join: sql``, where: sql``, rank: sql`0::real` };
  }
  const like = `%${q}%`;
  return {
    join: sql`LEFT JOIN catalog_documents d ON d.product_id = p.id`,
    where: sql`AND (
      d.search_vector @@ websearch_to_tsquery('english', ${q})
      OR p.title ILIKE ${like}
      OR p.brand ILIKE ${like}
      OR p.category ILIKE ${like}
    )`,
    rank: sql`COALESCE(ts_rank(d.search_vector, websearch_to_tsquery('english', ${q})), 0)`,
  };
}

function inList(column: SQL, values: string[] | undefined): SQL {
  if (!values || values.length === 0) return sql``;
  return sql`AND ${column} IN (${sql.join(values.map((v) => sql`${v}`), sql`, `)})`;
}

/**
 * Every filter except the one named, so a facet can count what ticking it would
 * actually return. A count computed with its own filter applied would read
 * "Running Shoes (12)" only after you had already narrowed to running shoes,
 * which tells the shopper nothing about where to go next.
 */
function filters(query: BrowseQuery, except?: "categories" | "brands"): SQL {
  const parts: SQL[] = [];
  if (except !== "categories") parts.push(inList(sql`p.category`, query.categories));
  if (except !== "brands") parts.push(inList(sql`p.brand`, query.brands));
  if (query.merchant) parts.push(sql`AND m.id = ${query.merchant}`);
  if (query.minPriceMinor != null) parts.push(sql`AND b.price_minor >= ${query.minPriceMinor}`);
  if (query.maxPriceMinor != null) parts.push(sql`AND b.price_minor <= ${query.maxPriceMinor}`);
  if (query.minRatingBp != null) parts.push(sql`AND p.rating_bp >= ${query.minRatingBp}`);
  return parts.length ? sql.join(parts, sql` `) : sql``;
}

function orderBy(sort: BrowseSort, hasQuery: boolean): SQL {
  switch (sort) {
    case "price_asc":
      return sql`price_minor ASC, title ASC`;
    case "price_desc":
      return sql`price_minor DESC, title ASC`;
    case "rating":
      return sql`rating_bp DESC NULLS LAST, rating_count DESC, title ASC`;
    case "popular":
      return sql`units DESC, rating_bp DESC NULLS LAST, title ASC`;
    case "newest":
      return sql`created_at DESC, title ASC`;
    case "relevance":
    default:
      // With no query typed there is nothing to be relevant TO, so "best match"
      // degrades to what sells — never to an arbitrary insertion order.
      return hasQuery
        ? sql`match_rank DESC, units DESC, rating_bp DESC NULLS LAST, title ASC`
        : sql`units DESC, rating_bp DESC NULLS LAST, title ASC`;
  }
}

/** Shared scaffold: the filtered, priced, in-stock-resolved candidate set. */
function baseQuery(query: BrowseQuery, except?: "categories" | "brands"): SQL {
  const text = textPredicate(query.q);
  return sql`
    WITH ${buyableCte(query.inStockOnly !== false)},
    sold AS (
      SELECT v.product_id, SUM(oi.quantity) AS units
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN product_variants v ON v.id = oi.variant_id
      WHERE o.state IN ('paid','fulfilled')
        AND o.created_at >= now() - interval '90 days'
      GROUP BY v.product_id
    ),
    base AS (
      SELECT p.id AS product_id, p.title, p.brand, p.category, p.image_urls,
             p.rating_bp, p.rating_count, p.created_at,
             m.name AS merchant_name,
             b.variant_id, b.price_minor, b.compare_at_price_minor, b.currency,
             b.image_url AS variant_image, b.in_stock,
             COALESCE(s.units, 0) AS units,
             ${text.rank} AS match_rank
      FROM products p
      JOIN merchants m ON m.id = p.merchant_id
      JOIN buyable b ON b.product_id = p.id
      LEFT JOIN sold s ON s.product_id = p.id
      ${text.join}
      WHERE p.status = 'active' AND m.status = 'active'
        ${text.where}
        ${filters(query, except)}
    )`;
}

export async function browseCatalog(query: BrowseQuery): Promise<BrowseResult> {
  const page = Math.max(1, query.page ?? 1);
  const sort = query.sort ?? "relevance";
  const offset = (page - 1) * PAGE_SIZE;

  // One round trip per question: the page of results, the total, and each facet
  // counted against the other filters. They are independent, so they overlap.
  const [rows, totals, categoryRows, brandRows, priceRows] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      ${baseQuery(query)}
      SELECT * FROM base
      ORDER BY ${orderBy(sort, Boolean(query.q))}
      LIMIT ${PAGE_SIZE} OFFSET ${offset}
    `),
    db.execute<Record<string, unknown>>(sql`
      ${baseQuery(query)}
      SELECT COUNT(*) AS total, MIN(price_minor) AS min_price, MAX(price_minor) AS max_price
      FROM base
    `),
    db.execute<Record<string, unknown>>(sql`
      ${baseQuery(query, "categories")}
      SELECT category AS value, COUNT(*) AS count FROM base
      GROUP BY category ORDER BY count DESC, category ASC
    `),
    db.execute<Record<string, unknown>>(sql`
      ${baseQuery(query, "brands")}
      SELECT brand AS value, COUNT(*) AS count FROM base
      WHERE brand IS NOT NULL
      GROUP BY brand ORDER BY count DESC, brand ASC
    `),
    // Bands come from the real distribution of what is on screen, never from
    // fixed thresholds — those either bunch a catalogue into one bucket or
    // offer bands with nothing in them. Counted in the same pass, because a
    // band is a promise: tapping it must return the number it showed.
    db.execute<Record<string, unknown>>(sql`
      ${baseQuery(query)},
      q AS (
        SELECT percentile_disc(0.25) WITHIN GROUP (ORDER BY price_minor) AS q1,
               percentile_disc(0.50) WITHIN GROUP (ORDER BY price_minor) AS q2,
               percentile_disc(0.75) WITHIN GROUP (ORDER BY price_minor) AS q3
        FROM base
      )
      SELECT q.q1, q.q2, q.q3,
             COUNT(*) FILTER (WHERE base.price_minor <= q.q1) AS c1,
             COUNT(*) FILTER (WHERE base.price_minor > q.q1 AND base.price_minor <= q.q2) AS c2,
             COUNT(*) FILTER (WHERE base.price_minor > q.q2 AND base.price_minor <= q.q3) AS c3,
             COUNT(*) FILTER (WHERE base.price_minor > q.q3) AS c4
      FROM base, q
      GROUP BY q.q1, q.q2, q.q3
    `),
  ]);

  const list = rows as unknown as Record<string, unknown>[];
  const summary = (totals as unknown as Record<string, unknown>[])[0] ?? {};
  const total = Number(summary.total ?? 0);
  const minPrice = summary.min_price != null ? Number(summary.min_price) : null;
  const maxPrice = summary.max_price != null ? Number(summary.max_price) : null;

  return {
    items: list.map((r) => ({
      productId: String(r.product_id),
      variantId: String(r.variant_id),
      title: String(r.title),
      brand: r.brand ? String(r.brand) : null,
      category: String(r.category),
      merchantName: String(r.merchant_name),
      priceMinor: Number(r.price_minor),
      compareAtPriceMinor: r.compare_at_price_minor != null ? Number(r.compare_at_price_minor) : null,
      currency: (r.currency as string) ?? "INR",
      // Variant photography wins where it exists — the listed variant is the
      // one being priced, so it should be the one pictured.
      imageUrl: (r.variant_image as string) ?? ((r.image_urls as string[]) ?? [])[0] ?? null,
      ratingBp: r.rating_bp != null ? Number(r.rating_bp) : null,
      ratingCount: Number(r.rating_count ?? 0),
      inStock: Boolean(r.in_stock),
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    categories: (categoryRows as unknown as Record<string, unknown>[]).map((r) => ({
      value: String(r.value),
      count: Number(r.count),
    })),
    brands: (brandRows as unknown as Record<string, unknown>[]).map((r) => ({
      value: String(r.value),
      count: Number(r.count),
    })),
    priceBands: bandsFrom(
      (priceRows as unknown as Record<string, unknown>[])[0] ?? {},
      minPrice,
      maxPrice,
    ),
    priceRange: minPrice != null && maxPrice != null ? { minMinor: minPrice, maxMinor: maxPrice } : null,
  };
}

/**
 * Quartile bands, deduplicated.
 *
 * A narrow result set collapses quartiles onto the same value; emitting them
 * anyway would offer two bands that select the same products, and one of them
 * would look broken. Fewer real bands beat four decorative ones, and a band
 * that came back empty is never shown at all.
 */
function bandsFrom(
  row: Record<string, unknown>,
  minPrice: number | null,
  maxPrice: number | null,
): BrowseResult["priceBands"] {
  if (minPrice == null || maxPrice == null || minPrice === maxPrice) return [];

  const cut = (v: unknown) => (v == null ? null : Number(v));
  const raw: { edge: number | null; count: number }[] = [
    { edge: cut(row.q1), count: Number(row.c1 ?? 0) },
    { edge: cut(row.q2), count: Number(row.c2 ?? 0) },
    { edge: cut(row.q3), count: Number(row.c3 ?? 0) },
    { edge: null, count: Number(row.c4 ?? 0) },
  ];

  const bands: BrowseResult["priceBands"] = [];
  let lower = 0;
  let carried = 0;
  for (const { edge, count } of raw) {
    // Quartiles that landed on the same price describe the same band twice, so
    // the duplicate's rows are carried into the next real one rather than lost.
    if (edge != null && edge < lower) {
      carried += count;
      continue;
    }
    const total = count + carried;
    carried = 0;
    if (total > 0) bands.push({ minMinor: lower, maxMinor: edge, count: total });
    else carried = total;
    if (edge == null) break;
    lower = edge + 1;
  }
  return bands.length > 1 ? bands : [];
}

/** Merchants with something active to browse — for the merchant filter. */
export async function browseMerchants(): Promise<{ id: string; name: string }[]> {
  const rows = (await db.execute<Record<string, unknown>>(sql`
    SELECT DISTINCT m.id, m.name
    FROM merchants m
    JOIN products p ON p.merchant_id = m.id AND p.status = 'active'
    WHERE m.status = 'active'
    ORDER BY m.name ASC
  `)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({ id: String(r.id), name: String(r.name) }));
}
