import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { merchantReviews, productReviews } from "@/db/schema";

/** Review read queries — see the note in support/queries.ts. */

export type ReviewableLine = {
  orderId: string;
  orderNumber: string;
  variantId: string;
  productId: string;
  title: string;
  attributes: Record<string, string>;
  merchantName: string;
  purchasedAt: string;
  existingStars: number | null;
  existingTitle: string | null;
  existingBody: string | null;
};

/** Items this shopper has bought, with any review they already left. */
export async function getReviewableLines(userId: string): Promise<ReviewableLine[]> {
  const rows = (await db.execute<Record<string, string>>(sql`
    SELECT o.id AS order_id, o.order_number, o.created_at AS purchased_at,
           oi.variant_id, oi.title_snapshot, oi.attributes_snapshot,
           v.product_id, m.name AS merchant_name,
           r.rating_bp, r.title AS review_title, r.body AS review_body
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN product_variants v ON v.id = oi.variant_id
    JOIN merchants m ON m.id = o.merchant_id
    LEFT JOIN product_reviews r
      ON r.order_id = o.id AND r.variant_id = oi.variant_id
    WHERE o.user_id = ${userId}
      AND o.state IN ('paid','fulfilled')
    ORDER BY o.created_at DESC
    LIMIT 40
  `)) as unknown as Record<string, string>[];

  return rows.map((r) => ({
    orderId: r.order_id,
    orderNumber: r.order_number,
    variantId: r.variant_id,
    productId: r.product_id,
    title: r.title_snapshot,
    attributes: (r.attributes_snapshot as unknown as Record<string, string>) ?? {},
    merchantName: r.merchant_name,
    purchasedAt: new Date(r.purchased_at).toISOString(),
    existingStars: r.rating_bp ? Number(r.rating_bp) / 1000 : null,
    existingTitle: r.review_title ?? null,
    existingBody: r.review_body ?? null,
  }));
}

export async function getProductReviews(productId: string, limit = 10) {
  return db
    .select()
    .from(productReviews)
    .where(eq(productReviews.productId, productId))
    .orderBy(desc(productReviews.createdAt))
    .limit(limit);
}

export async function getReviewCounts(productIds: string[]) {
  if (productIds.length === 0) return new Map<string, number>();
  const rows = await db
    .select({ productId: productReviews.productId, count: sql<number>`count(*)` })
    .from(productReviews)
    .where(inArray(productReviews.productId, productIds))
    .groupBy(productReviews.productId);
  return new Map(rows.map((r) => [r.productId, Number(r.count)]));
}

export type MerchantRating = {
  merchantId: string;
  /** Average of this merchant's product ratings — how good their catalogue is. */
  productRatingBp: number | null;
  productReviewCount: number;
  /** Average of order-level service ratings — how well they handle orders. */
  serviceRatingBp: number | null;
  serviceReviewCount: number;
};

/**
 * Merchant reputation.
 *
 * Two numbers rather than one, because they answer different questions and
 * blending them would hide the interesting case: a merchant with great products
 * and poor dispatch.
 */
export async function getMerchantRatings(merchantIds?: string[]) {
  const scope = merchantIds?.length
    ? sql`WHERE m.id IN (${sql.join(merchantIds.map((id) => sql`${id}`), sql`, `)})`
    : sql``;

  const rows = (await db.execute<Record<string, string>>(sql`
    SELECT m.id AS merchant_id,
           ROUND(AVG(p.rating_bp) FILTER (WHERE p.rating_bp IS NOT NULL))::int AS product_rating,
           COALESCE(SUM(p.rating_count) FILTER (WHERE p.rating_bp IS NOT NULL), 0) AS product_reviews,
           (SELECT ROUND(AVG(mr.rating_bp))::int FROM merchant_reviews mr WHERE mr.merchant_id = m.id) AS service_rating,
           (SELECT count(*) FROM merchant_reviews mr WHERE mr.merchant_id = m.id) AS service_reviews
    FROM merchants m
    LEFT JOIN products p ON p.merchant_id = m.id AND p.status = 'active'
    ${scope}
    GROUP BY m.id
  `)) as unknown as Record<string, string>[];

  return new Map<string, MerchantRating>(
    rows.map((r) => [
      r.merchant_id,
      {
        merchantId: r.merchant_id,
        productRatingBp: r.product_rating ? Number(r.product_rating) : null,
        productReviewCount: Number(r.product_reviews ?? 0),
        serviceRatingBp: r.service_rating ? Number(r.service_rating) : null,
        serviceReviewCount: Number(r.service_reviews ?? 0),
      },
    ]),
  );
}

/** Merchant service ratings this shopper has already left, keyed by order. */
export async function getMerchantReviewsByOrder(orderIds: string[]) {
  if (orderIds.length === 0) return new Map<string, { ratingBp: number; comment: string | null }>();
  const rows = await db
    .select()
    .from(merchantReviews)
    .where(inArray(merchantReviews.orderId, orderIds));
  return new Map(rows.map((r) => [r.orderId, { ratingBp: r.ratingBp, comment: r.comment }]));
}

export type ReviewWithContext = {
  id: string;
  productId: string;
  productTitle: string;
  category: string;
  merchantName: string;
  authorName: string;
  ratingBp: number;
  title: string | null;
  body: string | null;
  createdAt: Date;
  variantAttributes: Record<string, string>;
};

export type RatingBreakdown = {
  total: number;
  averageBp: number;
  /** Count per star, 1–5. */
  histogram: Record<number, number>;
};

function toBreakdown(rows: { rating_bp: number; n: number }[]): RatingBreakdown {
  const histogram: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0;
  let weighted = 0;
  for (const row of rows) {
    const star = Math.max(1, Math.min(5, Math.round(Number(row.rating_bp) / 1000)));
    histogram[star] += Number(row.n);
    total += Number(row.n);
    weighted += Number(row.rating_bp) * Number(row.n);
  }
  return { total, averageBp: total ? Math.round(weighted / total) : 0, histogram };
}

/**
 * Reviews of one product, newest first, with who wrote them.
 *
 * The catalogue carries thousands of reviews that nothing rendered — a shopper
 * asking "is this breathable?" had the answer sitting in the database and no
 * way to read it.
 */
export async function getProductReviewsDetailed(
  productId: string,
  limit = 20,
): Promise<{ reviews: ReviewWithContext[]; breakdown: RatingBreakdown }> {
  const rows = (await db.execute(sql`
    SELECT r.id, r.product_id, r.rating_bp, r.title, r.body, r.created_at,
           p.title AS product_title, p.category,
           m.name AS merchant_name,
           COALESCE(u.name, 'Verified buyer') AS author_name,
           v.attributes AS variant_attributes
    FROM product_reviews r
    JOIN products p ON p.id = r.product_id
    JOIN merchants m ON m.id = r.merchant_id
    JOIN users u ON u.id = r.user_id
    JOIN product_variants v ON v.id = r.variant_id
    WHERE r.product_id = ${productId}
    ORDER BY r.created_at DESC
    LIMIT ${limit}
  `)) as unknown as Record<string, unknown>[];

  const counts = (await db.execute(sql`
    SELECT rating_bp, count(*)::int AS n FROM product_reviews
    WHERE product_id = ${productId} GROUP BY rating_bp
  `)) as unknown as { rating_bp: number; n: number }[];

  return {
    reviews: rows.map((r) => ({
      id: String(r.id),
      productId: String(r.product_id),
      productTitle: String(r.product_title),
      category: String(r.category),
      merchantName: String(r.merchant_name),
      authorName: String(r.author_name),
      ratingBp: Number(r.rating_bp),
      title: r.title === null ? null : String(r.title),
      body: r.body === null ? null : String(r.body),
      createdAt: new Date(r.created_at as string),
      variantAttributes: (r.variant_attributes ?? {}) as Record<string, string>,
    })),
    breakdown: toBreakdown(counts),
  };
}

/** Every review left on a merchant's products, newest first. */
export async function getMerchantProductReviews(
  merchantId: string,
  options: { limit?: number; maxStars?: number } = {},
): Promise<{ reviews: ReviewWithContext[]; breakdown: RatingBreakdown }> {
  const limit = options.limit ?? 50;
  const ceiling = options.maxStars ? options.maxStars * 1000 + 999 : 5999;

  const rows = (await db.execute(sql`
    SELECT r.id, r.product_id, r.rating_bp, r.title, r.body, r.created_at,
           p.title AS product_title, p.category,
           m.name AS merchant_name,
           COALESCE(u.name, 'Verified buyer') AS author_name,
           v.attributes AS variant_attributes
    FROM product_reviews r
    JOIN products p ON p.id = r.product_id
    JOIN merchants m ON m.id = r.merchant_id
    JOIN users u ON u.id = r.user_id
    JOIN product_variants v ON v.id = r.variant_id
    WHERE r.merchant_id = ${merchantId} AND r.rating_bp <= ${ceiling}
    ORDER BY r.created_at DESC
    LIMIT ${limit}
  `)) as unknown as Record<string, unknown>[];

  const counts = (await db.execute(sql`
    SELECT rating_bp, count(*)::int AS n FROM product_reviews
    WHERE merchant_id = ${merchantId} GROUP BY rating_bp
  `)) as unknown as { rating_bp: number; n: number }[];

  return {
    reviews: rows.map((r) => ({
      id: String(r.id),
      productId: String(r.product_id),
      productTitle: String(r.product_title),
      category: String(r.category),
      merchantName: String(r.merchant_name),
      authorName: String(r.author_name),
      ratingBp: Number(r.rating_bp),
      title: r.title === null ? null : String(r.title),
      body: r.body === null ? null : String(r.body),
      createdAt: new Date(r.created_at as string),
      variantAttributes: (r.variant_attributes ?? {}) as Record<string, string>,
    })),
    breakdown: toBreakdown(counts),
  };
}

/** Reviews this shopper has written. */
export async function getReviewsByUser(userId: string, limit = 50): Promise<ReviewWithContext[]> {
  const rows = (await db.execute(sql`
    SELECT r.id, r.product_id, r.rating_bp, r.title, r.body, r.created_at,
           p.title AS product_title, p.category,
           m.name AS merchant_name,
           COALESCE(u.name, 'You') AS author_name,
           v.attributes AS variant_attributes
    FROM product_reviews r
    JOIN products p ON p.id = r.product_id
    JOIN merchants m ON m.id = r.merchant_id
    JOIN users u ON u.id = r.user_id
    JOIN product_variants v ON v.id = r.variant_id
    WHERE r.user_id = ${userId}
    ORDER BY r.created_at DESC
    LIMIT ${limit}
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    id: String(r.id),
    productId: String(r.product_id),
    productTitle: String(r.product_title),
    category: String(r.category),
    merchantName: String(r.merchant_name),
    authorName: String(r.author_name),
    ratingBp: Number(r.rating_bp),
    title: r.title === null ? null : String(r.title),
    body: r.body === null ? null : String(r.body),
    createdAt: new Date(r.created_at as string),
    variantAttributes: (r.variant_attributes ?? {}) as Record<string, string>,
  }));
}
