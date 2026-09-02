"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { carts } from "@/db/schema";
import { requireUser } from "@/lib/session";
import { addToCart, removeFromCart, setLineQuantity } from "./cart";

/** Cart mutations. Every one is scoped to the signed-in shopper's own carts. */

const addSchema = z.object({
  variantId: z.string().min(1),
  quantity: z.coerce.number().int().min(1).max(10),
});

export async function addToCartAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const parsed = addSchema.safeParse({
    variantId: formData.get("variantId"),
    quantity: formData.get("quantity"),
  });
  if (!parsed.success) return { error: "Choose a quantity between 1 and 10." };

  try {
    await addToCart({
      userId: user.id,
      variantId: parsed.data.variantId,
      quantity: parsed.data.quantity,
    });
  } catch (cause) {
    return { error: (cause as Error).message };
  }

  revalidatePath("/cart");
  revalidatePath("/shop");
  return {
    ok: true,
    message: `Added ${parsed.data.quantity} to your cart.`,
  };
}

export async function updateCartLineAction(input: {
  cartId: string;
  variantId: string;
  quantity: number;
}) {
  const user = await requireUser();
  const result = await setLineQuantity({ userId: user.id, ...input });
  revalidatePath("/cart");
  return result;
}

export async function removeCartLineAction(cartId: string, variantId: string) {
  const user = await requireUser();
  const [owned] = await db
    .select({ id: carts.id })
    .from(carts)
    .where(and(eq(carts.id, cartId), eq(carts.userId, user.id)))
    .limit(1);
  if (!owned) return { error: "That cart is not yours." };

  await removeFromCart(cartId, variantId);
  revalidatePath("/cart");
  return { ok: true };
}

export async function clearCartAction(cartId: string) {
  const user = await requireUser();
  const [owned] = await db
    .select({ id: carts.id })
    .from(carts)
    .where(and(eq(carts.id, cartId), eq(carts.userId, user.id)))
    .limit(1);
  if (!owned) return { error: "That cart is not yours." };

  const { clearCart } = await import("./cart");
  await clearCart(cartId);
  revalidatePath("/cart");
  return { ok: true };
}
