import { eq } from "drizzle-orm";
import { db } from "@/db";
import { inventory, productVariants, products } from "@/db/schema";
import { dedupeTags } from "@/server/agents/merchant/product-assistant";
import { MAX_VARIANTS } from "@/server/agents/merchant/variants";
import { indexCatalog } from "./indexer";
import { invalidateVocabulary } from "./vocabulary";

/**
 * The single writer for new products.
 *
 * There are two ways to create a product — the manual form and the assisted
 * wizard — and they legitimately parse different input: typed "key: value"
 * lines and one variant on one side, model-suggested JSON and N variant axes on
 * the other. What they must NOT do differently is *write*, and they had already
 * drifted three ways: only the wizard set `searchTags` (a 2.5x ranking penalty
 * for anything created manually), the two built SKUs with duplicate code, and
 * only the wizard bounded the variant count.
 *
 * So the seam is parse-per-form, write-once. This module is deliberately plain
 * rather than `"use server"` (NOTES.md §8.14) so it is importable and testable;
 * the actions above it do auth, parsing and redirects only.
 */

export type NewVariant = {
  attributes: Record<string, string>;
  priceMinor: number;
  quantity: number;
};

export type NewProductInput = {
  merchantId: string;
  merchantSlug: string;
  title: string;
  description: string;
  brand?: string | null;
  category: string;
  attributes: Record<string, unknown>;
  searchTags: string[];
  status: "draft" | "active";
  variants: NewVariant[];
};

export type CreateProductResult =
  | { ok: true; productId: string; variantCount: number }
  | { ok: false; error: string };

export function slugFragment(value: string, length: number): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, length) || "X";
}

/** Stable key for a variant's option set, order-independent. */
export function comboKey(attributes: Record<string, string>): string {
  return Object.keys(attributes)
    .sort()
    .map((k) => `${k.toLowerCase()}=${String(attributes[k]).toLowerCase().trim()}`)
    .join("|");
}

/**
 * Rejects a batch that cannot be written, before anything is inserted.
 *
 * Pure, so the rules are testable without a database.
 */
export function validateVariants(
  variants: NewVariant[],
): { ok: true } | { ok: false; error: string } {
  if (variants.length === 0) {
    // A product with no variant has no price and no stock: it would look
    // complete in the dashboard and be invisible to every agent.
    return { ok: false, error: "A product needs at least one variant." };
  }
  if (variants.length > MAX_VARIANTS) {
    return {
      ok: false,
      error: `That would create ${variants.length} variants. Trim the options to ${MAX_VARIANTS} or fewer, then add the rest from the product page.`,
    };
  }

  const seen = new Set<string>();
  for (const variant of variants) {
    const key = comboKey(variant.attributes);
    if (seen.has(key)) {
      return { ok: false, error: "Two of those variants have the same options." };
    }
    seen.add(key);
    if (!Number.isFinite(variant.priceMinor) || variant.priceMinor <= 0) {
      return { ok: false, error: "Every variant needs a price above zero." };
    }
    if (!Number.isInteger(variant.quantity) || variant.quantity < 0) {
      return { ok: false, error: "Stock must be zero or a whole number." };
    }
  }
  return { ok: true };
}

/**
 * Reserves unique SKUs for a whole batch.
 *
 * `reserved` matters: `slugFragment` truncates each option to four characters,
 * so "Large" and "Larger" both yield "LARG". Generating the batch concurrently
 * (as the wizard used to) lets two variants agree on a base that neither has
 * inserted yet, and `variants_sku_idx` then rejects the insert. Reserving in
 * sequence makes the collision visible before it reaches Postgres.
 */
export async function reserveSkus(
  merchantSlug: string,
  title: string,
  variants: NewVariant[],
): Promise<string[]> {
  const reserved = new Set<string>();
  const skus: string[] = [];

  for (const variant of variants) {
    const base = [
      slugFragment(merchantSlug.split("-")[0], 3),
      slugFragment(title.replace(/\s+/g, ""), 10),
      ...Object.values(variant.attributes).map((v) => slugFragment(v, 4)),
    ]
      .filter(Boolean)
      .join("-");

    let chosen = "";
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      if (reserved.has(candidate)) continue;
      const [taken] = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(eq(productVariants.sku, candidate))
        .limit(1);
      if (!taken) {
        chosen = candidate;
        break;
      }
    }
    if (!chosen) chosen = `${base}-${Date.now().toString(36).toUpperCase()}`;

    reserved.add(chosen);
    skus.push(chosen);
  }

  return skus;
}

/** Words that carry no matching value as a tag. */
const TAG_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "your", "our",
  "new", "pack", "set", "size", "pcs", "piece",
]);

/**
 * Deterministic tags for the manual form.
 *
 * The manual path previously wrote none at all, which cost it the measured 2.5x
 * ranking advantage tags carry (weight A) over description text (weight B).
 * This is deliberately NOT an LLM call: the manual form is the escape hatch
 * that has to keep working when the model is rate-limited, which NOTES.md
 * §8.13 treats as a normal path rather than an edge case.
 *
 * The brand is excluded on purpose, matching the assistant's tag prompt — a
 * bare brand tag matches every product the merchant sells.
 */
export function deriveSearchTags(input: {
  title: string;
  brand?: string | null;
  category: string;
}): string[] {
  const brand = (input.brand ?? "").trim();
  const withoutBrand = brand
    ? input.title.replace(new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "ig"), " ")
    : input.title;

  const phrase = withoutBrand.replace(/\s+/g, " ").trim();
  const words = phrase
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length >= 3 && !TAG_STOPWORDS.has(w.toLowerCase()));

  return dedupeTags([input.category, phrase, ...words]);
}

export async function createProductWithVariants(
  input: NewProductInput,
): Promise<CreateProductResult> {
  const valid = validateVariants(input.variants);
  if (!valid.ok) return valid;

  const [product] = await db
    .insert(products)
    .values({
      merchantId: input.merchantId,
      title: input.title,
      description: input.description,
      brand: input.brand ?? null,
      category: input.category,
      attributes: input.attributes,
      searchTags: input.searchTags,
      imageUrls: [],
      status: input.status,
    })
    .returning();

  const skus = await reserveSkus(input.merchantSlug, input.title, input.variants);

  const created = await db
    .insert(productVariants)
    .values(
      input.variants.map((variant, i) => ({
        productId: product.id,
        sku: skus[i],
        attributes: variant.attributes,
        priceMinor: variant.priceMinor,
        currency: "INR",
        active: true,
      })),
    )
    .returning();

  await db
    .insert(inventory)
    .values(created.map((v, i) => ({ variantId: v.id, quantity: input.variants[i].quantity })));

  // Re-index here rather than in each caller: the AI-readable catalog, the ACP
  // feed and the embeddings must never lag a write, and a caller can forget.
  await indexCatalog({ productIds: [product.id], force: true });
  invalidateVocabulary();

  return { ok: true, productId: product.id, variantCount: created.length };
}
