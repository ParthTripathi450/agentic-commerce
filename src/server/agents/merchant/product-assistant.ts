import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { normalizeTypography } from "@/lib/text";
import { completeJson, type LlmResult } from "@/server/ai/llm";
import { getVocabulary } from "@/server/catalog/vocabulary";

/**
 * Listing assistant for merchants.
 *
 * The agent proposes; the merchant decides. Nothing here writes to the
 * catalogue — every step returns suggestions the merchant confirms or replaces,
 * because a model asked for "brands that make running shoes" will happily
 * invent one, and an invented brand on a real storefront is a lie about stock.
 *
 * Suggestions are therefore split by provenance:
 *   - `onMarketplace`: read from this database. Facts.
 *   - `suggested`: model knowledge. Plausible, unverified, labelled as such.
 */

export type Provenance = "marketplace" | "suggested";

export type BrandSuggestion = { name: string; source: Provenance; productCount?: number };

export type BrandsResult = {
  /** The catalogue category this request resolved to, if any. */
  category: string | null;
  brands: BrandSuggestion[];
  degraded: boolean;
};

const brandsSchema = z.object({
  category: z.string().max(120).nullable(),
  brands: z.array(z.string().min(1).max(80)).max(12),
});

/** Brands already selling in a category — grounded in the catalogue. */
async function marketplaceBrands(category: string | null): Promise<BrandSuggestion[]> {
  const rows = (await db.execute<Record<string, string>>(sql`
    SELECT brand, count(*) AS n
    FROM products
    WHERE status = 'active' AND brand IS NOT NULL
      ${category ? sql`AND category = ${category}` : sql``}
    GROUP BY brand
    ORDER BY n DESC
    LIMIT 12
  `)) as unknown as Record<string, string>[];

  return rows.map((r) => ({
    name: r.brand,
    source: "marketplace" as const,
    productCount: Number(r.n),
  }));
}

/** Nearest catalogue category to what the merchant typed. */
function matchCategory(input: string, categories: string[]): string | null {
  const text = input.toLowerCase().trim();
  if (!text) return null;
  const exact = categories.find((c) => c.toLowerCase() === text);
  if (exact) return exact;
  const contained = categories
    .filter((c) => text.includes(c.toLowerCase()) || c.toLowerCase().includes(text))
    .sort((a, b) => b.length - a.length);
  return contained[0] ?? null;
}

export async function suggestBrands(itemQuery: string): Promise<BrandsResult> {
  const vocabulary = await getVocabulary();
  const matched = matchCategory(itemQuery, vocabulary.categories);
  const grounded = await marketplaceBrands(matched);
  const known = new Set(grounded.map((b) => b.name.toLowerCase()));

  const fallback = () =>
    JSON.stringify({ category: matched, brands: [] as string[] });

  try {
    const { value, meta } = await completeJson(
      {
        task: "generic",
        system: `You help a merchant list a product on a marketplace.

Given what they are selling, return the catalogue category it belongs to and real brands that make it.

Rules:
- "category" MUST be one of these exact values, or null if none fit:
  ${vocabulary.categories.join(", ")}
- "brands" are real, well-known manufacturers of that kind of product. Up to 10.
- Never invent a brand. If you are unsure a brand exists, leave it out.
- Return brand names only — no models, no descriptions.

Reply with JSON only: {"category":string|null,"brands":["..."]}`,
        messages: [{ role: "user", content: itemQuery }],
        temperature: 0.2,
        maxTokens: 700,
        reasoningEffort: "low",
        fallback,
      },
      (raw) => brandsSchema.parse(raw),
    );

    const category = value.category && vocabulary.categories.includes(value.category)
      ? value.category
      : matched;

    const suggested: BrandSuggestion[] = value.brands
      .map((b) => normalizeTypography(b))
      .filter((b) => b && !known.has(b.toLowerCase()))
      .map((name) => ({ name, source: "suggested" as const }));

    return {
      category,
      brands: [...grounded, ...suggested],
      degraded: meta.degraded,
    };
  } catch {
    return { category: matched, brands: grounded, degraded: true };
  }
}

export type ProductSuggestion = { name: string; source: Provenance };

const productsSchema = z.object({ products: z.array(z.string().min(1).max(160)).max(12) });

export async function suggestProducts(input: {
  brand: string;
  category: string | null;
}): Promise<{ products: ProductSuggestion[]; degraded: boolean }> {
  // Anything this brand already sells here is fact, and worth showing first.
  const rows = (await db.execute<Record<string, string>>(sql`
    SELECT DISTINCT title FROM products
    WHERE status = 'active' AND lower(brand) = lower(${input.brand})
    ORDER BY title LIMIT 8
  `)) as unknown as Record<string, string>[];

  const grounded: ProductSuggestion[] = rows.map((r) => ({
    name: r.title,
    source: "marketplace",
  }));
  const known = new Set(grounded.map((p) => p.name.toLowerCase()));

  try {
    const { value, meta } = await completeJson(
      {
        task: "generic",
        system: `List real products made by a given brand in a given category.

Rules:
- Real product lines or models only. Never invent a product name.
- If you are not confident the brand makes such a product, return an empty list.
- Product names only — no prices, no descriptions, no model years you are unsure of.
- Up to 8.

Reply with JSON only: {"products":["..."]}`,
        messages: [
          {
            role: "user",
            content: `Brand: ${input.brand}\nCategory: ${input.category ?? "unspecified"}`,
          },
        ],
        temperature: 0.2,
        maxTokens: 600,
        reasoningEffort: "low",
        fallback: () => JSON.stringify({ products: [] }),
      },
      (raw) => productsSchema.parse(raw),
    );

    const suggested: ProductSuggestion[] = value.products
      .map((p) => normalizeTypography(p))
      .filter((p) => p && !known.has(p.toLowerCase()))
      .map((name) => ({ name, source: "suggested" as const }));

    return { products: [...grounded, ...suggested], degraded: meta.degraded };
  } catch {
    return { products: grounded, degraded: true };
  }
}

export type ProductDraft = {
  title: string;
  description: string;
  /** key: value specifications agents filter on. */
  attributes: Record<string, string | number | boolean | string[]>;
  /** Internal search tags, weighted above the description in the index. */
  tags: string[];
  variantAxes: Record<string, string[]>;
  degraded: boolean;
  meta?: LlmResult;
};

const draftSchema = z.object({
  title: z.string().min(3).max(240),
  description: z.string().min(20).max(2000),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
  tags: z.array(z.string().min(2).max(40)).max(14),
  variantAxes: z.record(z.string(), z.array(z.string()).max(12)).optional(),
});

/**
 * Fills in the listing: description, specifications, variant axes and tags.
 *
 * This is the step the merchant explicitly does not want to be asked about, so
 * it runs unprompted — but everything it produces is presented for review
 * before anything is written.
 */
export async function generateProductDraft(input: {
  brand: string;
  productName: string;
  category: string | null;
}): Promise<ProductDraft> {
  const vocabulary = await getVocabulary();

  const fallback = (): ProductDraft => ({
    title: `${input.brand} ${input.productName}`.trim(),
    description: "",
    attributes: {},
    tags: [input.brand.toLowerCase(), ...(input.category ? [input.category.toLowerCase()] : [])],
    variantAxes: {},
    degraded: true,
  });

  try {
    const { value, meta } = await completeJson(
      {
        task: "generic",
        system: `You write a marketplace listing that AI shopping agents will search.

Produce a factual listing for the given product.

Rules:
- "description": 2-4 sentences of concrete, checkable detail — materials, dimensions,
  capacity, intended use. No marketing adjectives, no claims you cannot support.
- "attributes": structured specifications as key/value pairs. Agents FILTER on these,
  so prefer precise keys ("capacityLitres": 45) over prose. 5-12 entries.
- "variantAxes": the options this product is normally sold in, e.g.
  {"size":["S","M","L"],"color":["black","navy"]}. Empty object if it has none.
- "tags": 6-12 short internal search terms. These are ranked ABOVE the description,
  so they should capture how a shopper would ASK for this — use cases, problems it
  solves, common synonyms and category words. Not the brand name, not the title.
  Examples for a running shoe: "road running", "daily trainer", "cushioned",
  "marathon training", "neutral gait".
- Invent nothing. If a specification is not something you can state confidently for
  this product, leave it out rather than guessing a number.

Known catalogue categories: ${vocabulary.categories.join(", ")}

Reply with JSON only:
{"title":string,"description":string,"attributes":object,"tags":["..."],"variantAxes":object}`,
        messages: [
          {
            role: "user",
            content: `Brand: ${input.brand}\nProduct: ${input.productName}\nCategory: ${input.category ?? "unspecified"}`,
          },
        ],
        temperature: 0.3,
        maxTokens: 1600,
        reasoningEffort: "low",
        fallback: () => JSON.stringify(fallback()),
      },
      (raw) => draftSchema.parse(raw),
    );

    return {
      title: normalizeTypography(value.title),
      description: normalizeTypography(value.description),
      attributes: value.attributes,
      tags: dedupeTags(value.tags.map((t) => normalizeTypography(t))),
      variantAxes: value.variantAxes ?? {},
      degraded: meta.degraded,
      meta,
    };
  } catch {
    return fallback();
  }
}

/** Lower-cased, trimmed, de-duplicated; tags are matched, not displayed as prose. */
export function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.toLowerCase().trim().replace(/\s+/g, " ");
    if (!tag || tag.length < 2 || tag.length > 40) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out.slice(0, 14);
}
