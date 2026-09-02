import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { merchantPolicies, merchants } from "@/db/schema";
import { env } from "@/lib/env";
import { formatMoney, toMinor } from "@/lib/money";
import { hybridSearch } from "@/server/catalog/search";
import { rankCandidates } from "@/server/agents/customer/ranker";
import { getVocabulary } from "@/server/catalog/vocabulary";

/**
 * MCP tool surface.
 *
 * Transport-agnostic so the same definitions serve both stdio (desktop clients)
 * and Streamable HTTP (our own web agent).
 *
 * Read tools are public — a catalog exists to be discovered. Anything that
 * spends money is deliberately NOT exposed as a callable tool: `prepare_purchase`
 * assembles a cart and returns a URL where the human authorizes it. An MCP
 * client therefore cannot cause a charge, only propose one, which is the same
 * consent boundary AP2 draws.
 */

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});
const fail = (message: string): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
  isError: true,
});

export const searchProductsSchema = z.object({
  query: z.string().min(2).describe("What the shopper wants, in natural language"),
  color: z.string().optional().describe("Exact colour from the catalog vocabulary"),
  size: z.string().optional().describe("Exact size from the catalog vocabulary"),
  category: z.string().optional(),
  brand: z.string().optional(),
  max_price: z.number().positive().optional().describe("Maximum price in RUPEES, not paise"),
  min_price: z.number().positive().optional(),
  merchant: z.string().optional().describe("Restrict to one merchant slug"),
  in_stock_only: z.boolean().default(true),
  limit: z.number().int().min(1).max(20).default(5),
});

export async function searchProducts(input: z.infer<typeof searchProductsSchema>): Promise<ToolResult> {
  const attributes: Record<string, string> = {};
  if (input.color) attributes.color = input.color;
  if (input.size) attributes.size = input.size;

  const result = await hybridSearch({
    text: input.query,
    category: input.category ?? null,
    brand: input.brand ?? null,
    attributes,
    priceMaxMinor: input.max_price ? toMinor(input.max_price) : null,
    priceMinMinor: input.min_price ? toMinor(input.min_price) : null,
    merchantSlugs: input.merchant ? [input.merchant] : undefined,
    requireInStock: input.in_stock_only,
    limit: input.limit,
  });

  const ranking = rankCandidates(result.candidates, {
    budgetMinor: input.max_price ? toMinor(input.max_price) : null,
    rejected: result.rejected,
    limit: input.limit,
  });

  return ok({
    matches: ranking.ranked.map((item) => ({
      rank: item.rank,
      variant_id: item.candidate.variant.id,
      sku: item.candidate.variant.sku,
      title: item.candidate.title,
      merchant: item.candidate.merchant.name,
      merchant_slug: item.candidate.merchant.slug,
      price: formatMoney(item.candidate.variant.priceMinor),
      price_minor: item.candidate.variant.priceMinor,
      options: item.candidate.variant.attributes,
      in_stock: item.candidate.variant.availableQuantity,
      delivery_days: item.candidate.policies.standardDeliveryDays,
      return_window_days: item.candidate.policies.returnWindowDays,
      rating: item.candidate.ratingBp ? item.candidate.ratingBp / 1000 : null,
      review_count: item.candidate.ratingCount,
      score: item.score,
      // The scoring is published so a calling agent can explain the choice
      // rather than inventing a rationale of its own.
      score_breakdown: item.criteria.map((c) => ({
        factor: c.name,
        weight: c.weight,
        normalized: c.normalized,
        contribution: c.contribution,
      })),
    })),
    // Why plausible-looking products are absent, so the caller can say so.
    excluded: result.rejected.slice(0, 8).map((r) => ({
      title: r.title,
      merchant: r.merchantName,
      reason: r.detail,
    })),
    searched_merchants: result.stats.merchantsSearched,
    considered: result.stats.considered,
  });
}

export const getProductSchema = z.object({
  variant_id: z.string().optional(),
  sku: z.string().optional(),
});

export async function getProduct(input: z.infer<typeof getProductSchema>): Promise<ToolResult> {
  if (!input.variant_id && !input.sku) return fail("Provide either variant_id or sku.");

  const rows = (await db.execute<Record<string, unknown>>(sql`
    SELECT p.title, p.description, p.brand, p.category, p.attributes,
           p.rating_bp, p.rating_count,
           v.id AS variant_id, v.sku, v.attributes AS variant_attributes,
           v.price_minor, v.compare_at_price_minor, v.currency,
           GREATEST(COALESCE(i.quantity,0) - COALESCE(i.reserved,0), 0) AS available,
           m.name AS merchant_name, m.slug AS merchant_slug,
           mp.return_window_days, mp.returns_accepted, mp.standard_delivery_days,
           mp.return_policy_text, mp.warranty_text
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    JOIN merchants m ON m.id = p.merchant_id
    LEFT JOIN merchant_policies mp ON mp.merchant_id = m.id
    LEFT JOIN inventory i ON i.variant_id = v.id
    WHERE ${input.variant_id ? sql`v.id = ${input.variant_id}` : sql`v.sku = ${input.sku}`}
    LIMIT 1
  `)) as unknown as Record<string, string>[];

  if (rows.length === 0) return fail("No such product variant.");
  const row = rows[0];

  return ok({
    variant_id: row.variant_id,
    sku: row.sku,
    title: row.title,
    description: row.description,
    brand: row.brand,
    category: row.category,
    specifications: row.attributes,
    options: row.variant_attributes,
    price: formatMoney(Number(row.price_minor)),
    price_minor: Number(row.price_minor),
    available: Number(row.available),
    merchant: { name: row.merchant_name, slug: row.merchant_slug },
    rating: row.rating_bp ? Number(row.rating_bp) / 1000 : null,
    review_count: Number(row.rating_count),
    policies: {
      returns_accepted: row.returns_accepted,
      return_window_days: Number(row.return_window_days ?? 0),
      delivery_days: Number(row.standard_delivery_days ?? 7),
      return_policy: row.return_policy_text,
      warranty: row.warranty_text,
    },
  });
}

export const checkAvailabilitySchema = z.object({
  variant_ids: z.array(z.string()).min(1).max(20),
});

export async function checkAvailability(
  input: z.infer<typeof checkAvailabilitySchema>,
): Promise<ToolResult> {
  const rows = (await db.execute<Record<string, unknown>>(sql`
    SELECT v.id AS variant_id, v.sku, v.active,
           GREATEST(COALESCE(i.quantity,0) - COALESCE(i.reserved,0), 0) AS available,
           i.restock_eta
    FROM product_variants v
    LEFT JOIN inventory i ON i.variant_id = v.id
    WHERE v.id IN (${sql.join(input.variant_ids.map((id) => sql`${id}`), sql`, `)})
  `)) as unknown as Record<string, string>[];

  return ok({
    checked_at: new Date().toISOString(),
    items: rows.map((row) => ({
      variant_id: row.variant_id,
      sku: row.sku,
      purchasable: Boolean(row.active) && Number(row.available) > 0,
      available: Number(row.available),
      restock_eta: row.restock_eta ?? null,
    })),
  });
}

export async function listMerchants(): Promise<ToolResult> {
  const base = env().PLATFORM_URL.replace(/\/$/, "");
  const rows = await db
    .select({
      slug: merchants.slug,
      name: merchants.name,
      description: merchants.description,
      fulfillmentRate: merchants.fulfillmentRate,
      returnWindow: merchantPolicies.returnWindowDays,
      deliveryDays: merchantPolicies.standardDeliveryDays,
    })
    .from(merchants)
    .leftJoin(merchantPolicies, eq(merchantPolicies.merchantId, merchants.id))
    .where(eq(merchants.status, "active"));

  return ok({
    merchants: rows.map((m) => ({
      slug: m.slug,
      name: m.name,
      description: m.description,
      fulfillment_rate: `${((m.fulfillmentRate ?? 0) / 100).toFixed(1)}%`,
      return_window_days: m.returnWindow,
      delivery_days: m.deliveryDays,
      ucp_manifest: `${base}/api/ucp/${m.slug}/manifest`,
      acp_feed: `${base}/api/acp/${m.slug}/feed.json`,
    })),
  });
}

export async function getCatalogVocabulary(): Promise<ToolResult> {
  const vocabulary = await getVocabulary();
  return ok({
    categories: vocabulary.categories,
    brands: vocabulary.brands,
    variant_axes: vocabulary.axes,
    note: "Filters must use these exact values; anything else returns no matches.",
  });
}

export const preparePurchaseSchema = z.object({
  variant_id: z.string(),
  quantity: z.number().int().min(1).max(10).default(1),
});

/**
 * Assembles a purchase and hands back an authorization URL.
 *
 * Deliberately does NOT charge: an MCP client is an untrusted caller, so the
 * human completes authorization in the app where the amount, the merchant and
 * the spending limits are shown. This mirrors the AP2 boundary — an agent may
 * propose a cart, only a person may approve the payment.
 */
export async function preparePurchase(
  input: z.infer<typeof preparePurchaseSchema>,
): Promise<ToolResult> {
  const base = env().PLATFORM_URL.replace(/\/$/, "");
  const detail = await getProduct({ variant_id: input.variant_id });
  if (detail.isError) return detail;

  const product = JSON.parse(detail.content[0].text) as {
    title: string;
    price_minor: number;
    available: number;
    merchant: { name: string };
  };

  if (product.available < input.quantity) {
    return fail(
      product.available === 0
        ? `${product.title} is out of stock.`
        : `Only ${product.available} of ${product.title} available.`,
    );
  }

  return ok({
    status: "authorization_required",
    product: product.title,
    merchant: product.merchant.name,
    quantity: input.quantity,
    estimated_total: formatMoney(product.price_minor * input.quantity),
    note:
      "This platform never lets an agent complete a payment. Open the authorization URL to review " +
      "the exact amount, the applied spending limits and the signed mandate chain, then approve it.",
    authorization_url: `${base}/shop?buy=${input.variant_id}&qty=${input.quantity}`,
  });
}

export const TOOLS = [
  {
    name: "search_products",
    description:
      "Search every merchant's catalog with natural language plus exact filters. Returns ranked matches with a published score breakdown, and the reasons plausible products were excluded.",
    schema: searchProductsSchema,
    handler: searchProducts,
  },
  {
    name: "get_product",
    description: "Full detail for one product variant, including live stock and merchant policies.",
    schema: getProductSchema,
    handler: getProduct,
  },
  {
    name: "check_availability",
    description: "Live purchasable stock for up to 20 variants at once.",
    schema: checkAvailabilitySchema,
    handler: checkAvailability,
  },
  {
    name: "list_merchants",
    description: "All active merchants with their policies and protocol endpoints.",
    schema: z.object({}),
    handler: listMerchants,
  },
  {
    name: "get_catalog_vocabulary",
    description:
      "The exact categories, brands and variant values the catalog uses. Call this before filtering so searches do not silently return nothing.",
    schema: z.object({}),
    handler: getCatalogVocabulary,
  },
  {
    name: "prepare_purchase",
    description:
      "Assemble a purchase and return a URL where the human authorizes payment. Cannot charge; approval always happens in the app.",
    schema: preparePurchaseSchema,
    handler: preparePurchase,
  },
] as const;
