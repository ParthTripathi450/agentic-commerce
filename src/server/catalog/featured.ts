import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Products to show before the shopper has searched.
 *
 * Ranked by units sold in the last 30 days across the whole marketplace, so the
 * landing state is real merchandising rather than filler — and it gives the
 * agent's suggestions something concrete to sit beside.
 */
export type FeaturedProduct = {
  productId: string;
  variantId: string;
  title: string;
  category: string;
  merchantName: string;
  priceMinor: number;
  currency: string;
  imageUrl: string | null;
  ratingBp: number | null;
  ratingCount: number;
  unitsSold: number;
};

export async function getFeaturedProducts(limit = 8): Promise<FeaturedProduct[]> {
  const rows = (await db.execute<Record<string, string>>(sql`
    WITH sold AS (
      SELECT v.product_id, SUM(oi.quantity) AS units
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN product_variants v ON v.id = oi.variant_id
      WHERE o.state IN ('paid','fulfilled')
        AND o.created_at >= now() - interval '30 days'
      GROUP BY v.product_id
    ),
    cheapest AS (
      SELECT DISTINCT ON (v.product_id)
             v.product_id, v.id AS variant_id, v.price_minor, v.currency
      FROM product_variants v
      JOIN inventory i ON i.variant_id = v.id
      WHERE v.active = true AND GREATEST(i.quantity - i.reserved, 0) > 0
      ORDER BY v.product_id, v.price_minor ASC
    )
    SELECT p.id AS product_id, p.title, p.category, p.image_urls,
           p.rating_bp, p.rating_count,
           m.name AS merchant_name,
           c.variant_id, c.price_minor, c.currency,
           COALESCE(s.units, 0) AS units
    FROM products p
    JOIN merchants m ON m.id = p.merchant_id
    JOIN cheapest c ON c.product_id = p.id
    LEFT JOIN sold s ON s.product_id = p.id
    WHERE p.status = 'active' AND m.status = 'active'
    ORDER BY COALESCE(s.units, 0) DESC, p.rating_bp DESC NULLS LAST
    LIMIT ${limit}
  `)) as unknown as Record<string, string>[];

  return rows.map((r) => ({
    productId: r.product_id,
    variantId: r.variant_id,
    title: r.title,
    category: r.category,
    merchantName: r.merchant_name,
    priceMinor: Number(r.price_minor),
    currency: r.currency ?? "INR",
    imageUrl: ((r.image_urls as unknown as string[]) ?? [])[0] ?? null,
    ratingBp: r.rating_bp ? Number(r.rating_bp) : null,
    ratingCount: Number(r.rating_count ?? 0),
    unitsSold: Number(r.units),
  }));
}
