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
