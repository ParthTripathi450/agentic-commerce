"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  merchantReviews,
  orderItems,
  orders,
  productReviews,
  productVariants,
} from "@/db/schema";
import { requireUser } from "@/lib/session";
import { indexCatalog } from "@/server/catalog/indexer";

/**
 * Customer reviews of items they actually bought.
 *
 * Ratings carry real weight in the ranker (0.20 of the default mix), so the
 * right to leave one is gated on an order line the shopper owns. The product's
 * aggregate is updated incrementally rather than recomputed, because the seeded
 * baseline rating has no review rows behind it and a full recompute would
 * silently erase it.
 */

const reviewSchema = z.object({
  orderId: z.string().min(1),
  variantId: z.string().min(1),
  /** Whole or half stars, 1–5, stored in the same basis as products.ratingBp. */
  stars: z.coerce.number().min(1).max(5),
  title: z.string().max(160).optional(),
  body: z.string().max(2000).optional(),
});

export async function submitReviewAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const parsed = reviewSchema.safeParse({
    orderId: formData.get("orderId"),
    variantId: formData.get("variantId"),
    stars: formData.get("stars"),
    title: formData.get("title") || undefined,
    body: formData.get("body") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Choose a rating and try again." };
  }

  const ratingBp = Math.round(parsed.data.stars * 1000);

  // The order must be this shopper's, paid for, and contain this variant.
  const [line] = await db
    .select({
      orderState: orders.state,
      merchantId: orders.merchantId,
      productId: productVariants.productId,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(productVariants, eq(productVariants.id, orderItems.variantId))
    .where(
      and(
        eq(orderItems.orderId, parsed.data.orderId),
        eq(orderItems.variantId, parsed.data.variantId),
        eq(orders.userId, user.id),
      ),
    )
    .limit(1);

  if (!line) return { error: "You can only review items from your own orders." };
  if (line.orderState !== "fulfilled" && line.orderState !== "paid") {
    return { error: "You can review an item once the order has been paid for." };
  }

  const [existing] = await db
    .select({ id: productReviews.id, ratingBp: productReviews.ratingBp })
    .from(productReviews)
    .where(
      and(
        eq(productReviews.orderId, parsed.data.orderId),
        eq(productReviews.variantId, parsed.data.variantId),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(productReviews)
      .set({
        ratingBp,
        title: parsed.data.title ?? null,
        body: parsed.data.body ?? null,
        updatedAt: new Date(),
      })
      .where(eq(productReviews.id, existing.id));
    // Editing shifts the mean without changing the count.
    await adjustAggregate(line.productId, ratingBp - existing.ratingBp, 0);
  } else {
    await db.insert(productReviews).values({
      productId: line.productId,
      variantId: parsed.data.variantId,
      merchantId: line.merchantId,
      userId: user.id,
      orderId: parsed.data.orderId,
      ratingBp,
      title: parsed.data.title ?? null,
      body: parsed.data.body ?? null,
    });
    await adjustAggregate(line.productId, ratingBp, 1);
  }

  // The rating line is part of the product's AI document, so agents see it.
  await indexCatalog({ productIds: [line.productId], force: true });
  revalidatePath("/orders");
  return {
    ok: true,
    message: existing ? "Your review was updated." : "Thanks — your review is live.",
  };
}

/**
 * Moves the running average.
 *
 * `delta` is the rating being added, or the change on an edit; `countDelta` is
 * 1 for a new review and 0 for an edit.
 */
async function adjustAggregate(productId: string, delta: number, countDelta: 0 | 1) {
  await db.execute(sql`
    UPDATE products
    SET rating_bp = GREATEST(0, ROUND(
          ((COALESCE(rating_bp, 0)::numeric * COALESCE(rating_count, 0)) + ${delta})
          / GREATEST(COALESCE(rating_count, 0) + ${countDelta}, 1)
        ))::int,
        rating_count = COALESCE(rating_count, 0) + ${countDelta},
        updated_at = now()
    WHERE id = ${productId}
  `);
}

const merchantReviewSchema = z.object({
  orderId: z.string().min(1),
  stars: z.coerce.number().min(1).max(5),
  comment: z.string().max(1000).optional(),
});

/**
 * Rates the merchant's handling of an order.
 *
 * Distinct from rating the product: this is about dispatch, packaging and
 * communication — the things only the merchant controls. Gated on an order the
 * shopper actually placed with them.
 */
export async function submitMerchantReviewAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const parsed = merchantReviewSchema.safeParse({
    orderId: formData.get("orderId"),
    stars: formData.get("stars"),
    comment: formData.get("comment") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Choose a rating and try again." };
  }

  const [order] = await db
    .select({ id: orders.id, merchantId: orders.merchantId, state: orders.state })
    .from(orders)
    .where(and(eq(orders.id, parsed.data.orderId), eq(orders.userId, user.id)))
    .limit(1);

  if (!order) return { error: "You can only rate merchants you have ordered from." };
  if (order.state !== "paid" && order.state !== "fulfilled") {
    return { error: "You can rate the merchant once the order has been paid for." };
  }

  const ratingBp = Math.round(parsed.data.stars * 1000);
  const values = {
    merchantId: order.merchantId,
    userId: user.id,
    orderId: order.id,
    ratingBp,
    comment: parsed.data.comment ?? null,
    updatedAt: new Date(),
  };

  await db
    .insert(merchantReviews)
    .values(values)
    .onConflictDoUpdate({
      target: merchantReviews.orderId,
      set: { ratingBp, comment: values.comment, updatedAt: new Date() },
    });

  revalidatePath("/orders");
  return { ok: true, message: "Thanks — your merchant rating is saved." };
}
