"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { inventory, productVariants, products } from "@/db/schema";
import { toMinor } from "@/lib/money";
import { requireMerchant } from "@/lib/session";
import { indexCatalog } from "@/server/catalog/indexer";
import { invalidateVocabulary } from "@/server/catalog/vocabulary";
import {
  dedupeTags,
  generateProductDraft,
  suggestBrands,
  suggestProducts,
} from "./product-assistant";

/**
 * Assisted listing.
 *
 * The wizard's steps are exposed as actions so the browser never talks to the
 * model directly and every suggestion passes through the same server that owns
 * the catalogue. Nothing is written until the merchant submits the final step.
 */

export async function suggestBrandsAction(itemQuery: string) {
  await requireMerchant();
  if (itemQuery.trim().length < 2) return { category: null, brands: [], degraded: false };
  return suggestBrands(itemQuery.trim());
}

export async function suggestProductsAction(brand: string, category: string | null) {
  await requireMerchant();
  if (brand.trim().length < 1) return { products: [], degraded: false };
  return suggestProducts({ brand: brand.trim(), category });
}

export async function generateDraftAction(input: {
  brand: string;
  productName: string;
  category: string | null;
}) {
  await requireMerchant();
  const draft = await generateProductDraft(input);
  // The LlmResult carries no useful client information and is not serialisable
  // in a stable shape; the degraded flag is what the UI needs.
  return { ...draft, meta: undefined };
}

/** Cap on generated variants, so a 10×5 axis pair cannot create 50 SKUs by accident. */
const MAX_VARIANTS = 24;

const createSchema = z.object({
  title: z.string().min(3).max(240),
  description: z.string().max(4000),
  brand: z.string().max(120).optional(),
  category: z.string().min(2).max(120),
  attributesJson: z.string().max(6000),
  tagsJson: z.string().max(3000),
  axesJson: z.string().max(4000),
  price: z.coerce.number().min(1).max(10_000_000),
  quantity: z.coerce.number().int().min(0).max(1_000_000),
  status: z.enum(["draft", "active"]),
});

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function slugFragment(value: string, length: number) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, length) || "X";
}

async function uniqueSku(base: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const [taken] = await db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(eq(productVariants.sku, candidate))
      .limit(1);
    if (!taken) return candidate;
  }
  return `${base}-${Date.now().toString(36).toUpperCase()}`;
}

export async function createAssistedProductAction(_prev: unknown, formData: FormData) {
  const { merchant } = await requireMerchant();

  const parsed = createSchema.safeParse({
    title: formData.get("title"),
    description: formData.get("description") ?? "",
    brand: formData.get("brand") || undefined,
    category: formData.get("category"),
    attributesJson: formData.get("attributesJson") ?? "{}",
    tagsJson: formData.get("tagsJson") ?? "[]",
    axesJson: formData.get("axesJson") ?? "{}",
    price: formData.get("price"),
    quantity: formData.get("quantity"),
    status: formData.get("status"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the fields and try again." };
  }

  const data = parsed.data;
  const attributes = parseJson<Record<string, unknown>>(data.attributesJson, {});
  const tags = dedupeTags(parseJson<string[]>(data.tagsJson, []));
  const axes = parseJson<Record<string, string[]>>(data.axesJson, {});

  // Cartesian product of the axis values the merchant kept.
  let combos: Record<string, string>[] = [{}];
  for (const [axis, values] of Object.entries(axes)) {
    const kept = values.filter(Boolean);
    if (kept.length === 0) continue;
    combos = combos.flatMap((combo) => kept.map((v) => ({ ...combo, [axis]: v })));
  }
  if (combos.length > MAX_VARIANTS) {
    return {
      error: `That would create ${combos.length} variants. Trim the options to ${MAX_VARIANTS} or fewer, then add the rest from the product page.`,
    };
  }

  const [product] = await db
    .insert(products)
    .values({
      merchantId: merchant.id,
      title: data.title,
      description: data.description,
      brand: data.brand ?? null,
      category: data.category,
      attributes,
      searchTags: tags,
      imageUrls: [],
      status: data.status,
    })
    .returning();

  const created = await db
    .insert(productVariants)
    .values(
      await Promise.all(
        combos.map(async (combo) => ({
          productId: product.id,
          sku: await uniqueSku(
            [
              slugFragment(merchant.slug.split("-")[0], 3),
              slugFragment(data.title.replace(/\s+/g, ""), 10),
              ...Object.values(combo).map((v) => slugFragment(v, 4)),
            ].join("-"),
          ),
          attributes: combo,
          priceMinor: toMinor(data.price),
          currency: "INR",
          active: true,
        })),
      ),
    )
    .returning();

  await db
    .insert(inventory)
    .values(created.map((v) => ({ variantId: v.id, quantity: data.quantity })));

  await indexCatalog({ productIds: [product.id], force: true });
  invalidateVocabulary();
  revalidatePath("/merchant/products");
  redirect(`/merchant/products/${product.id}`);
}

const tagsSchema = z.object({
  productId: z.string().min(1),
  tagsJson: z.string().max(3000),
});

/** Merchants own their tags outright: add, edit or delete whatever the agent proposed. */
export async function updateProductTagsAction(_prev: unknown, formData: FormData) {
  const { merchant } = await requireMerchant();
  const parsed = tagsSchema.safeParse({
    productId: formData.get("productId"),
    tagsJson: formData.get("tagsJson") ?? "[]",
  });
  if (!parsed.success) return { error: "Could not read those tags." };

  const tags = dedupeTags(parseJson<string[]>(parsed.data.tagsJson, []));

  const updated = await db
    .update(products)
    .set({ searchTags: tags, updatedAt: new Date() })
    .where(and(eq(products.id, parsed.data.productId), eq(products.merchantId, merchant.id)))
    .returning({ id: products.id });

  if (updated.length === 0) return { error: "That product is not yours to edit." };

  // Tags are weighted in the search index, so a change must be re-indexed.
  await indexCatalog({ productIds: [parsed.data.productId], force: true });
  revalidatePath(`/merchant/products/${parsed.data.productId}`);
  return {
    ok: true,
    message: `${tags.length} tag${tags.length === 1 ? "" : "s"} saved and re-indexed.`,
  };
}

/** Regenerates tags for an existing product, leaving the merchant to approve them. */
export async function regenerateTagsAction(productId: string) {
  const { merchant } = await requireMerchant();
  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.merchantId, merchant.id)))
    .limit(1);
  if (!product) return { error: "That product is not yours." };

  const draft = await generateProductDraft({
    brand: product.brand ?? "",
    productName: product.title,
    category: product.category,
  });

  return { ok: true, tags: draft.tags, degraded: draft.degraded };
}
