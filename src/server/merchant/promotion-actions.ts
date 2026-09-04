"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { promotions } from "@/db/schema";
import { toMinor } from "@/lib/money";
import { requireMerchant } from "@/lib/session";

/**
 * Merchant-authored promotions.
 *
 * Deliberately NOT bounded by the merchant agent's discount limit: those limits
 * exist to constrain the agent, not the person who set them. A merchant
 * discounting their own stock is exercising authority, not delegating it.
 */

const createSchema = z.object({
  title: z.string().min(3).max(160),
  code: z.string().max(40).optional(),
  type: z.enum(["percentage_off", "flat_off", "free_shipping"]),
  value: z.coerce.number().min(0).max(1_000_000),
  minSubtotal: z.coerce.number().min(0).max(10_000_000).optional(),
  activeTo: z.string().optional(),
  /**
   * Which categories the offer covers. Empty means the whole catalogue.
   *
   * Scoping was in the schema and ignored by the cart, so a merchant could set
   * "shoes only" and watch it discount everything. `resolvePromotion` honours
   * it now, which is what makes offering the field honest.
   */
  categories: z.array(z.string().max(120)).max(20).default([]),
});

export async function createPromotionAction(_prev: unknown, formData: FormData) {
  const { merchant } = await requireMerchant();
  const parsed = createSchema.safeParse({
    title: formData.get("title"),
    code: formData.get("code") || undefined,
    type: formData.get("type"),
    value: formData.get("value"),
    minSubtotal: formData.get("minSubtotal") || undefined,
    activeTo: formData.get("activeTo") || undefined,
    categories: formData.getAll("categories").filter((c): c is string => typeof c === "string"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the fields and try again." };
  }

  const data = parsed.data;
  if (data.type === "percentage_off" && (data.value <= 0 || data.value > 90)) {
    return { error: "A percentage discount must be between 1 and 90." };
  }
  if (data.type === "flat_off" && data.value <= 0) {
    return { error: "A flat discount needs an amount above zero." };
  }

  const code = data.code?.trim().toUpperCase() || null;
  if (code) {
    const [existing] = await db
      .select({ id: promotions.id })
      .from(promotions)
      .where(and(eq(promotions.merchantId, merchant.id), eq(promotions.code, code)))
      .limit(1);
    if (existing) return { error: `You already have a promotion with the code ${code}.` };
  }

  await db.insert(promotions).values({
    merchantId: merchant.id,
    title: data.title,
    code,
    type: data.type,
    // Percentages are stored in basis points; flat amounts in minor units.
    value:
      data.type === "percentage_off"
        ? Math.round(data.value * 100)
        : data.type === "flat_off"
          ? toMinor(data.value)
          : 0,
    conditions: {
      ...(data.minSubtotal ? { minSubtotalMinor: toMinor(data.minSubtotal) } : {}),
      ...(data.categories.length > 0 ? { categories: data.categories } : {}),
    },
    active: true,
    activeFrom: new Date(),
    activeTo: data.activeTo ? new Date(data.activeTo) : null,
    createdByAgent: false,
  });

  revalidatePath("/merchant/promotions");
  return { ok: true, message: code ? `Promotion created. Customers apply it with ${code}.` : "Promotion created." };
}

export async function togglePromotionAction(promotionId: string, active: boolean) {
  const { merchant } = await requireMerchant();
  const updated = await db
    .update(promotions)
    .set({ active, updatedAt: new Date() })
    .where(and(eq(promotions.id, promotionId), eq(promotions.merchantId, merchant.id)))
    .returning({ id: promotions.id });

  if (updated.length === 0) return { error: "That promotion is not yours." };
  revalidatePath("/merchant/promotions");
  return { ok: true, message: active ? "Promotion resumed." : "Promotion paused." };
}

export async function deletePromotionAction(promotionId: string) {
  const { merchant } = await requireMerchant();
  const deleted = await db
    .delete(promotions)
    .where(and(eq(promotions.id, promotionId), eq(promotions.merchantId, merchant.id)))
    .returning({ id: promotions.id });

  if (deleted.length === 0) return { error: "That promotion is not yours." };
  revalidatePath("/merchant/promotions");
  return { ok: true, message: "Promotion deleted." };
}

export async function listPromotions(merchantId: string) {
  return db
    .select()
    .from(promotions)
    .where(eq(promotions.merchantId, merchantId))
    .orderBy(desc(promotions.createdAt));
}
