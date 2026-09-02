import { sql } from "drizzle-orm";
import { db } from "@/db";
import { env } from "@/lib/env";
import { toMajor } from "@/lib/money";

/**
 * ACP product feed.
 *
 * This IS the "AI-readable catalog" — merchants author products in the
 * dashboard and the feed is derived, so there is no separate artefact to keep
 * in sync. Field names follow the ACP Product Feed spec (Google Shopping
 * lineage) so an agent that already reads that format needs no adapter.
 */

export type FeedItem = {
  id: string;
  item_group_id: string;
  title: string;
  description: string;
  link: string;
  image_link: string | null;
  price: string;
  sale_price?: string;
  availability: "in_stock" | "out_of_stock" | "preorder";
  inventory_quantity: number;
  brand: string | null;
  product_category: string;
  condition: "new";
  gtin?: string;
  color?: string;
  size?: string;
  seller_name: string;
  seller_url: string;
  shipping: { price: string; delivery_days: number };
  return_policy: { accepted: boolean; window_days: number; description: string | null };
  rating?: { value: number; count: number };
  /** Non-standard, but what makes a listing rankable by an agent. */
  attributes: Record<string, unknown>;
  updated_at: string;
};

export type Feed = {
  version: string;
  spec: string;
  merchant: { id: string; name: string; slug: string; url: string };
  currency: string;
  generated_at: string;
  item_count: number;
  items: FeedItem[];
};

function priceString(minor: number, currency: string) {
  return `${toMajor(minor).toFixed(2)} ${currency}`;
}

export async function buildFeed(merchantSlug: string): Promise<Feed | null> {
  const base = env().PLATFORM_URL.replace(/\/$/, "");

  const rows = (await db.execute<Record<string, unknown>>(sql`
    SELECT
      m.id AS merchant_id, m.name AS merchant_name, m.slug AS merchant_slug,
      mp.currency, mp.flat_shipping_minor, mp.free_shipping_above_minor,
      mp.standard_delivery_days, mp.returns_accepted, mp.return_window_days,
      mp.return_policy_text,
      p.id AS product_id, p.title, p.description, p.brand, p.category,
      p.attributes, p.image_urls, p.rating_bp, p.rating_count, p.updated_at,
      v.id AS variant_id, v.sku, v.attributes AS variant_attributes,
      v.price_minor, v.compare_at_price_minor, v.barcode,
      GREATEST(COALESCE(i.quantity,0) - COALESCE(i.reserved,0), 0) AS available
    FROM merchants m
    LEFT JOIN merchant_policies mp ON mp.merchant_id = m.id
    JOIN products p ON p.merchant_id = m.id AND p.status = 'active'
    JOIN product_variants v ON v.product_id = p.id AND v.active = true
    LEFT JOIN inventory i ON i.variant_id = v.id
    WHERE m.slug = ${merchantSlug} AND m.status = 'active'
    ORDER BY p.title, v.sku
  `)) as unknown as Record<string, string>[];

  if (rows.length === 0) return null;

  const head = rows[0];
  const currency = String(head.currency ?? "INR");

  const items: FeedItem[] = rows.map((row) => {
    const available = Number(row.available);
    const variantAttrs = (row.variant_attributes as unknown as Record<string, string>) ?? {};
    const images = (row.image_urls as unknown as string[]) ?? [];
    const compareAt = row.compare_at_price_minor ? Number(row.compare_at_price_minor) : null;
    const price = Number(row.price_minor);

    return {
      id: String(row.sku),
      item_group_id: String(row.product_id),
      title: String(row.title),
      description: String(row.description ?? ""),
      link: `${base}/p/${row.product_id}?variant=${row.variant_id}`,
      image_link: images[0] ?? null,
      // When a compare-at price exists it is the list price and the live price
      // is the sale price — otherwise agents read a discount that isn't offered.
      price: priceString(compareAt ?? price, currency),
      ...(compareAt ? { sale_price: priceString(price, currency) } : {}),
      availability: available > 0 ? "in_stock" : "out_of_stock",
      inventory_quantity: available,
      brand: row.brand ? String(row.brand) : null,
      product_category: String(row.category),
      condition: "new",
      ...(row.barcode ? { gtin: String(row.barcode) } : {}),
      ...(variantAttrs.color ? { color: variantAttrs.color } : {}),
      ...(variantAttrs.size ? { size: variantAttrs.size } : {}),
      seller_name: String(row.merchant_name),
      seller_url: `${base}/m/${row.merchant_slug}`,
      shipping: {
        price: priceString(Number(row.flat_shipping_minor ?? 0), currency),
        delivery_days: Number(row.standard_delivery_days ?? 7),
      },
      return_policy: {
        accepted: Boolean(row.returns_accepted),
        window_days: Number(row.return_window_days ?? 0),
        description: row.return_policy_text ? String(row.return_policy_text) : null,
      },
      ...(row.rating_bp
        ? { rating: { value: Number(row.rating_bp) / 1000, count: Number(row.rating_count) } }
        : {}),
      attributes: (row.attributes as unknown as Record<string, unknown>) ?? {},
      updated_at: new Date(String(row.updated_at)).toISOString(),
    };
  });

  return {
    version: "1.0",
    spec: "agentic-commerce-protocol/product-feed",
    merchant: {
      id: String(head.merchant_id),
      name: String(head.merchant_name),
      slug: String(head.merchant_slug),
      url: `${base}/m/${head.merchant_slug}`,
    },
    currency,
    generated_at: new Date().toISOString(),
    item_count: items.length,
    items,
  };
}

/** CSV rendering for agents that ingest tabular feeds rather than JSON. */
export function feedToCsv(feed: Feed): string {
  const columns = [
    "id", "item_group_id", "title", "description", "link", "image_link", "price",
    "sale_price", "availability", "inventory_quantity", "brand", "product_category",
    "condition", "gtin", "color", "size", "seller_name", "shipping_price",
    "delivery_days", "returns_accepted", "return_window_days",
  ];

  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const lines = [columns.join(",")];
  for (const item of feed.items) {
    lines.push(
      [
        item.id, item.item_group_id, item.title, item.description, item.link,
        item.image_link, item.price, item.sale_price ?? "", item.availability,
        item.inventory_quantity, item.brand, item.product_category, item.condition,
        item.gtin ?? "", item.color ?? "", item.size ?? "", item.seller_name,
        item.shipping.price, item.shipping.delivery_days,
        item.return_policy.accepted, item.return_policy.window_days,
      ].map(escape).join(","),
    );
  }
  return lines.join("\n");
}

export async function listActiveMerchantSlugs(): Promise<string[]> {
  const rows = await db.execute<{ slug: string }>(
    sql`SELECT slug FROM merchants WHERE status = 'active' ORDER BY slug`,
  );
  return (rows as unknown as { slug: string }[]).map((r) => r.slug);
}
