"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import { requireMerchant } from "@/lib/session";
import { buildKey, storage, validateUpload } from "@/server/storage";

/**
 * Product images.
 *
 * Images do not affect ranking — agents match on structured attributes and
 * text, not pictures — but they appear in the ACP feed's `image_link`, which is
 * what a shopping surface renders to a human once the agent has chosen.
 */

const MAX_IMAGES = 6;

export async function uploadProductImageAction(_prev: unknown, formData: FormData) {
  const { merchant } = await requireMerchant();
  const productId = String(formData.get("productId") ?? "");
  const file = formData.get("image");

  if (!(file instanceof File)) return { error: "Choose an image to upload." };

  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.merchantId, merchant.id)))
    .limit(1);
  if (!product) return { error: "That product is not yours to edit." };

  if (product.imageUrls.length >= MAX_IMAGES) {
    return { error: `A product can have at most ${MAX_IMAGES} images.` };
  }

  const validated = await validateUpload(file);
  if (!validated.ok) return { error: validated.error };

  let stored;
  try {
    stored = await storage().put(
      buildKey(merchant.slug, product.id, validated.type.ext),
      validated.bytes,
      validated.type.mime,
    );
  } catch (cause) {
    return { error: `Upload failed: ${(cause as Error).message}` };
  }

  await db
    .update(products)
    .set({ imageUrls: [...product.imageUrls, stored.url], updatedAt: new Date() })
    .where(eq(products.id, product.id));

  revalidatePath(`/merchant/products/${product.id}`);
  return { ok: true, message: "Image added.", url: stored.url };
}

export async function removeProductImageAction(productId: string, url: string) {
  const { merchant } = await requireMerchant();

  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.merchantId, merchant.id)))
    .limit(1);
  if (!product) return { error: "That product is not yours to edit." };

  await db
    .update(products)
    .set({ imageUrls: product.imageUrls.filter((u) => u !== url), updatedAt: new Date() })
    .where(eq(products.id, product.id));

  // Best-effort delete: the reference is gone either way, so a failed unlink
  // must not fail the request.
  const key = url.replace(/^\/uploads\//, "").replace(/^.*\/object\/public\/[^/]+\//, "");
  await storage().remove(key).catch(() => undefined);

  revalidatePath(`/merchant/products/${productId}`);
  return { ok: true, message: "Image removed." };
}
