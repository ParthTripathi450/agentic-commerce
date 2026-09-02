import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Everything a shopper needs to decide on one product.
 *
 * Read-only and deliberately outside any `"use server"` module (§7), so it can
 * be called straight from the page without becoming a POST endpoint.
 */

export type ProductVariantView = {
  variantId: string;
  sku: string;
  attributes: Record<string, string>;
  priceMinor: number;
  compareAtPriceMinor: number | null;
  currency: string;
  availableQuantity: number;
};

export type ProductDetail = {
  productId: string;
  title: string;
  description: string;
  brand: string | null;
  category: string;
  attributes: Record<string, unknown>;
  searchTags: string[];
  imageUrls: string[];
  ratingBp: number | null;
  ratingCount: number;
  merchant: {
    id: string;
    slug: string;
    name: string;
    returnWindowDays: number;
    returnsAccepted: boolean;
    standardDeliveryDays: number;
  };
  variants: ProductVariantView[];
  /** Cheapest in-stock variant, so the page can open on something buyable. */
  defaultVariantId: string | null;
};

export async function getProductDetail(productId: string): Promise<ProductDetail | null> {
  const [row] = (await db.execute(sql`
    SELECT p.id, p.title, p.description, p.brand, p.category, p.attributes,
           p.search_tags, p.image_urls, p.rating_bp, p.rating_count,
           m.id AS merchant_id, m.slug AS merchant_slug, m.name AS merchant_name,
           mp.return_window_days, mp.returns_accepted, mp.standard_delivery_days
    FROM products p
    JOIN merchants m ON m.id = p.merchant_id
    LEFT JOIN merchant_policies mp ON mp.merchant_id = m.id
    WHERE p.id = ${productId} AND p.status = 'active'
    LIMIT 1
  `)) as unknown as Record<string, unknown>[];

  if (!row) return null;

  const variants = (await db.execute(sql`
    SELECT v.id, v.sku, v.attributes, v.price_minor, v.compare_at_price_minor, v.currency,
           GREATEST(COALESCE(i.quantity, 0) - COALESCE(i.reserved, 0), 0) AS available
    FROM product_variants v
    LEFT JOIN inventory i ON i.variant_id = v.id
    WHERE v.product_id = ${productId} AND v.active = true
    ORDER BY v.price_minor ASC
  `)) as unknown as Record<string, unknown>[];

  const mapped: ProductVariantView[] = variants.map((v) => ({
    variantId: String(v.id),
    sku: String(v.sku),
    attributes: (v.attributes ?? {}) as Record<string, string>,
    priceMinor: Number(v.price_minor),
    compareAtPriceMinor: v.compare_at_price_minor === null ? null : Number(v.compare_at_price_minor),
    currency: String(v.currency),
    availableQuantity: Number(v.available ?? 0),
  }));

  return {
    productId: String(row.id),
    title: String(row.title),
    description: String(row.description ?? ""),
    brand: row.brand === null ? null : String(row.brand),
    category: String(row.category),
    attributes: (row.attributes ?? {}) as Record<string, unknown>,
    searchTags: (row.search_tags ?? []) as string[],
    imageUrls: (row.image_urls ?? []) as string[],
    ratingBp: row.rating_bp === null ? null : Number(row.rating_bp),
    ratingCount: Number(row.rating_count ?? 0),
    merchant: {
      id: String(row.merchant_id),
      slug: String(row.merchant_slug),
      name: String(row.merchant_name),
      returnWindowDays: Number(row.return_window_days ?? 0),
      returnsAccepted: row.returns_accepted !== false,
      standardDeliveryDays: Number(row.standard_delivery_days ?? 3),
    },
    variants: mapped,
    // Opens on something that can actually be bought, not just the cheapest row.
    defaultVariantId: mapped.find((v) => v.availableQuantity > 0)?.variantId ?? null,
  };
}
