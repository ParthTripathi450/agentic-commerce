"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { availabilityWindows, inventory, productVariants, products } from "@/db/schema";
import { toMinor } from "@/lib/money";
import { requireMerchant } from "@/lib/session";
import { parseAttributeLines, toStringMap } from "@/server/catalog/attributes";
import {
  createProductWithVariants,
  deriveSearchTags,
  reserveSkus,
} from "@/server/catalog/create-product";
import { indexCatalog } from "@/server/catalog/indexer";
import { invalidateVocabulary } from "@/server/catalog/vocabulary";

/**
 * Product mutations.
 *
 * Every write re-indexes the affected product, so the AI-readable catalog, the
 * ACP feed and the embeddings never drift from what the merchant just saved —
 * there is no separate "publish to AI" step to forget.
 */

const productSchema = z.object({
  productId: z.string().min(1),
  title: z.string().min(3).max(240),
  description: z.string().max(4000),
  brand: z.string().max(120).optional(),
  category: z.string().min(2).max(120),
  status: z.enum(["draft", "active", "archived"]),
  attributes: z.string().max(4000).optional(),
});

export async function updateProductAction(_prev: unknown, formData: FormData) {
  const { merchant } = await requireMerchant();
  const parsed = productSchema.safeParse({
    productId: formData.get("productId"),
    title: formData.get("title"),
    description: formData.get("description"),
    brand: formData.get("brand") || undefined,
    category: formData.get("category"),
    status: formData.get("status"),
    attributes: formData.get("attributes") ?? undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the fields and try again." };
  }

  const { productId, attributes, ...fields } = parsed.data;
  const updated = await db
    .update(products)
    .set({
      ...fields,
      brand: fields.brand ?? null,
      ...(attributes !== undefined ? { attributes: parseAttributeLines(attributes) } : {}),
      updatedAt: new Date(),
    })
    // Scoped to the merchant so one shop cannot edit another's catalog.
    .where(and(eq(products.id, productId), eq(products.merchantId, merchant.id)))
    .returning({ id: products.id });

  if (updated.length === 0) return { error: "That product is not yours to edit." };

  await indexCatalog({ productIds: [productId], force: true });
  invalidateVocabulary();
  revalidatePath("/merchant/products");
  revalidatePath(`/merchant/products/${productId}`);
  return { ok: true, message: "Saved and re-indexed for AI discovery." };
}

const variantSchema = z.object({
  variantId: z.string().min(1),
  productId: z.string().min(1),
  price: z.coerce.number().min(1).max(10_000_000),
  quantity: z.coerce.number().int().min(0).max(1_000_000),
  lowStockThreshold: z.coerce.number().int().min(0).max(10_000),
  active: z.coerce.boolean(),
});

export async function updateVariantAction(_prev: unknown, formData: FormData) {
  const { merchant } = await requireMerchant();
  const parsed = variantSchema.safeParse({
    variantId: formData.get("variantId"),
    productId: formData.get("productId"),
    price: formData.get("price"),
    quantity: formData.get("quantity"),
    lowStockThreshold: formData.get("lowStockThreshold"),
    active: formData.get("active") === "on",
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the fields and try again." };
  }

  // Confirm ownership before touching price or stock.
  const [owned] = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        eq(productVariants.id, parsed.data.variantId),
        eq(products.merchantId, merchant.id),
      ),
    )
    .limit(1);
  if (!owned) return { error: "That variant is not yours to edit." };

  await db
    .update(productVariants)
    .set({
      priceMinor: toMinor(parsed.data.price),
      active: parsed.data.active,
      updatedAt: new Date(),
    })
    .where(eq(productVariants.id, parsed.data.variantId));

  await db
    .insert(inventory)
    .values({
      variantId: parsed.data.variantId,
      quantity: parsed.data.quantity,
      lowStockThreshold: parsed.data.lowStockThreshold,
    })
    .onConflictDoUpdate({
      target: inventory.variantId,
      set: {
        quantity: parsed.data.quantity,
        lowStockThreshold: parsed.data.lowStockThreshold,
        updatedAt: new Date(),
      },
    });

  // Price is part of the AI document; stock is queried live, but re-indexing
  // here keeps the feed's price fields correct immediately.
  await indexCatalog({ productIds: [parsed.data.productId], force: true });
  revalidatePath(`/merchant/products/${parsed.data.productId}`);
  revalidatePath("/merchant");
  return { ok: true, message: "Variant updated." };
}

export async function reindexCatalogAction() {
  const { merchant } = await requireMerchant();
  const rows = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.merchantId, merchant.id));

  const result = await indexCatalog({ productIds: rows.map((r) => r.id), force: true });
  invalidateVocabulary();
  revalidatePath("/merchant/protocols");
  return { indexed: result.indexed, total: result.total, durationMs: result.durationMs };
}

export async function getMerchantProducts(merchantId: string) {
  const rows = (await db.execute<Record<string, string>>(sql`
    SELECT p.id, p.title, p.category, p.brand, p.status,
           count(v.id) AS variant_count,
           min(v.price_minor) AS min_price,
           max(v.price_minor) AS max_price,
           COALESCE(SUM(GREATEST(i.quantity - i.reserved, 0)), 0) AS total_stock,
           (cd.product_id IS NOT NULL) AS indexed
    FROM products p
    LEFT JOIN product_variants v ON v.product_id = p.id
    LEFT JOIN inventory i ON i.variant_id = v.id
    LEFT JOIN catalog_documents cd ON cd.product_id = p.id AND cd.embedding IS NOT NULL
    WHERE p.merchant_id = ${merchantId}
    GROUP BY p.id, p.title, p.category, p.brand, p.status, cd.product_id
    ORDER BY p.title
  `)) as unknown as Record<string, string>[];

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    category: r.category,
    brand: r.brand,
    status: r.status,
    variantCount: Number(r.variant_count),
    minPriceMinor: Number(r.min_price ?? 0),
    maxPriceMinor: Number(r.max_price ?? 0),
    totalStock: Number(r.total_stock),
    // Postgres returns booleans as t/f strings through the raw driver.
    indexed: String(r.indexed) === "true" || String(r.indexed) === "t",
  }));
}


/** Renders stored attributes back into the editable `key: value` form. */
export async function formatAttributeLines(attributes: Record<string, unknown>): Promise<string> {
  return Object.entries(attributes)
    .map(([key, value]) => {
      const label = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
      const rendered = Array.isArray(value) ? value.join(", ") : String(value);
      return `${label}: ${rendered}`;
    })
    .join("\n");
}


const createProductSchema = z.object({
  title: z.string().min(3).max(240),
  description: z.string().max(4000),
  category: z.string().min(2).max(120),
  brand: z.string().max(120).optional(),
  attributes: z.string().max(4000).optional(),
  status: z.enum(["draft", "active"]),
  price: z.coerce.number().min(1).max(10_000_000),
  quantity: z.coerce.number().int().min(0).max(1_000_000),
  variantAttributes: z.string().max(500).optional(),
});

/**
 * Creates a product together with its first variant.
 *
 * Parsing only — the write goes through `createProductWithVariants`, the same
 * path the assisted wizard uses, so the two cannot drift again.
 */
export async function createProductAction(_prev: unknown, formData: FormData) {
  const { merchant } = await requireMerchant();
  const parsed = createProductSchema.safeParse({
    title: formData.get("title"),
    description: formData.get("description"),
    category: formData.get("category"),
    brand: formData.get("brand") || undefined,
    attributes: formData.get("attributes") || undefined,
    status: formData.get("status"),
    price: formData.get("price"),
    quantity: formData.get("quantity"),
    variantAttributes: formData.get("variantAttributes") || undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the fields and try again." };
  }

  const data = parsed.data;

  const result = await createProductWithVariants({
    merchantId: merchant.id,
    merchantSlug: merchant.slug,
    title: data.title,
    description: data.description,
    brand: data.brand ?? null,
    category: data.category,
    attributes: parseAttributeLines(data.attributes ?? ""),
    // Derived deterministically: this form must keep working with no model.
    searchTags: deriveSearchTags({
      title: data.title,
      brand: data.brand ?? null,
      category: data.category,
    }),
    status: data.status,
    variants: [
      {
        attributes: toStringMap(parseAttributeLines(data.variantAttributes ?? "")),
        priceMinor: toMinor(data.price),
        quantity: data.quantity,
      },
    ],
  });

  if (!result.ok) return { error: result.error };

  revalidatePath("/merchant/products");
  redirect(`/merchant/products/${result.productId}`);
}


const addVariantSchema = z.object({
  productId: z.string().min(1),
  variantAttributes: z.string().max(500),
  price: z.coerce.number().min(1).max(10_000_000),
  quantity: z.coerce.number().int().min(0).max(1_000_000),
});

export async function addVariantAction(_prev: unknown, formData: FormData) {
  const { merchant } = await requireMerchant();
  const parsed = addVariantSchema.safeParse({
    productId: formData.get("productId"),
    variantAttributes: formData.get("variantAttributes"),
    price: formData.get("price"),
    quantity: formData.get("quantity"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the fields and try again." };
  }

  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, parsed.data.productId), eq(products.merchantId, merchant.id)))
    .limit(1);
  if (!product) return { error: "That product is not yours to edit." };

  const attributes = Object.fromEntries(
    Object.entries(parseAttributeLines(parsed.data.variantAttributes)).map(([k, v]) => [
      k,
      String(v),
    ]),
  );
  if (Object.keys(attributes).length === 0) {
    return { error: "Describe the variant, e.g. \"size: 11\" and \"color: black\"." };
  }

  // Reject a duplicate combination rather than creating an unsellable twin.
  const siblings = await db
    .select({ attributes: productVariants.attributes })
    .from(productVariants)
    .where(eq(productVariants.productId, product.id));
  const duplicate = siblings.some(
    (s) => JSON.stringify(s.attributes) === JSON.stringify(attributes),
  );
  if (duplicate) return { error: "A variant with those exact options already exists." };

  const [variant] = await db
    .insert(productVariants)
    .values({
      productId: product.id,
      sku: (
        await reserveSkus(merchant.slug, product.title, [
          { attributes, priceMinor: toMinor(parsed.data.price), quantity: parsed.data.quantity },
        ])
      )[0],
      attributes,
      priceMinor: toMinor(parsed.data.price),
      currency: "INR",
      active: true,
    })
    .returning();

  await db.insert(inventory).values({ variantId: variant.id, quantity: parsed.data.quantity });

  await indexCatalog({ productIds: [product.id], force: true });
  invalidateVocabulary();
  revalidatePath(`/merchant/products/${product.id}`);
  return { ok: true, message: `Added variant ${variant.sku}.` };
}

export async function deleteVariantAction(variantId: string, productId: string) {
  const { merchant } = await requireMerchant();

  const [owned] = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(eq(productVariants.id, variantId), eq(products.merchantId, merchant.id)))
    .limit(1);
  if (!owned) return { error: "That variant is not yours to remove." };

  const remaining = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(eq(productVariants.productId, productId));
  if (remaining.length <= 1) {
    return { error: "A product needs at least one variant. Archive the product instead." };
  }

  // Past orders reference variants, so deactivate rather than delete — removing
  // it would break order history.
  await db
    .update(productVariants)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(productVariants.id, variantId));

  await indexCatalog({ productIds: [productId], force: true });
  revalidatePath(`/merchant/products/${productId}`);
  return { ok: true, message: "Variant withdrawn from sale." };
}

const availabilitySchema = z.object({
  variantId: z.string().min(1),
  productId: z.string().min(1),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
});

/**
 * Sets a sale window for a variant.
 *
 * A variant with no window is always purchasable. With one, it is only sellable
 * inside it — the search layer already enforces this, so a window is how a
 * merchant schedules a drop or ends a seasonal line without deleting anything.
 */
export async function setAvailabilityWindowAction(_prev: unknown, formData: FormData) {
  const { merchant } = await requireMerchant();
  const parsed = availabilitySchema.safeParse({
    variantId: formData.get("variantId"),
    productId: formData.get("productId"),
    startsAt: formData.get("startsAt") || undefined,
    endsAt: formData.get("endsAt") || undefined,
  });
  if (!parsed.success) return { error: "Check the dates and try again." };

  const [owned] = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(eq(productVariants.id, parsed.data.variantId), eq(products.merchantId, merchant.id)))
    .limit(1);
  if (!owned) return { error: "That variant is not yours to edit." };

  // Clearing both fields removes the window, restoring "always available".
  await db
    .delete(availabilityWindows)
    .where(eq(availabilityWindows.variantId, parsed.data.variantId));

  if (!parsed.data.startsAt && !parsed.data.endsAt) {
    revalidatePath(`/merchant/products/${parsed.data.productId}`);
    return { ok: true, message: "Window cleared — always available." };
  }

  const startsAt = parsed.data.startsAt ? new Date(parsed.data.startsAt) : new Date();
  const endsAt = parsed.data.endsAt ? new Date(parsed.data.endsAt) : null;

  if (endsAt && endsAt <= startsAt) {
    return { error: "The end date must be after the start date." };
  }

  await db.insert(availabilityWindows).values({
    variantId: parsed.data.variantId,
    startsAt,
    endsAt,
  });

  revalidatePath(`/merchant/products/${parsed.data.productId}`);
  const now = new Date();
  const live = startsAt <= now && (!endsAt || endsAt >= now);
  return {
    ok: true,
    message: live
      ? "Window saved — on sale now."
      : `Window saved — not purchasable until ${startsAt.toLocaleDateString("en-IN")}.`,
  };
}

export async function getAvailabilityWindow(variantId: string) {
  const [window] = await db
    .select()
    .from(availabilityWindows)
    .where(eq(availabilityWindows.variantId, variantId))
    .limit(1);
  return window ?? null;
}
