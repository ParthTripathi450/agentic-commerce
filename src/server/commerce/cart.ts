import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  cartItems,
  carts,
  inventory,
  merchantPolicies,
  merchants,
  productVariants,
  products,
  promotions,
  type Totals,
} from "@/db/schema";
import { applyBp, formatMoney } from "@/lib/money";

/** GST applied to the discounted subtotal. */
export const TAX_BP = 1800;

export type CartLine = {
  cartItemId: string;
  variantId: string;
  productId: string;
  title: string;
  sku: string;
  attributes: Record<string, string>;
  quantity: number;
  /** Price captured when the item was added. */
  unitPriceMinor: number;
  /** Price in the catalog right now. */
  currentPriceMinor: number;
  availableQuantity: number;
  active: boolean;
};

export type CartIssue = {
  variantId: string;
  kind: "price_changed" | "out_of_stock" | "insufficient_stock" | "inactive";
  detail: string;
};

export type CartView = {
  cartId: string;
  merchant: { id: string; slug: string; name: string };
  lines: CartLine[];
  totals: Totals;
  /** Anything that must be resolved before this cart can be signed or charged. */
  issues: CartIssue[];
  appliedPromotion: { id: string; code: string | null; title: string } | null;
};

/** Creates or reuses an open cart. Carts are single-merchant. */
export async function getOrCreateCart(userId: string, merchantId: string, agentSessionId?: string) {
  const [existing] = await db
    .select()
    .from(carts)
    .where(
      and(eq(carts.userId, userId), eq(carts.merchantId, merchantId), eq(carts.status, "open")),
    )
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(carts)
    .values({ userId, merchantId, agentSessionId: agentSessionId ?? null })
    .returning();
  return created;
}

/**
 * Adds a variant to the shopper's cart.
 *
 * The price is read from the catalog, never accepted from the caller — an agent
 * or a client must not be able to name its own price.
 */
export async function addToCart(input: {
  userId: string;
  variantId: string;
  quantity?: number;
  agentSessionId?: string;
}) {
  const [row] = await db
    .select({
      variant: productVariants,
      product: products,
      merchantId: products.merchantId,
      available: sql<number>`GREATEST(COALESCE(${inventory.quantity},0) - COALESCE(${inventory.reserved},0), 0)`,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(inventory, eq(inventory.variantId, productVariants.id))
    .where(eq(productVariants.id, input.variantId))
    .limit(1);

  if (!row) throw new Error("That product variant no longer exists.");
  if (!row.variant.active || row.product.status !== "active") {
    throw new Error("That product is not currently for sale.");
  }

  const quantity = Math.max(1, input.quantity ?? 1);
  if (row.available < quantity) {
    throw new Error(
      row.available === 0
        ? "That option is out of stock."
        : `Only ${row.available} left in stock.`,
    );
  }

  const cart = await getOrCreateCart(input.userId, row.merchantId, input.agentSessionId);

  await db
    .insert(cartItems)
    .values({
      cartId: cart.id,
      variantId: input.variantId,
      quantity,
      unitPriceMinor: row.variant.priceMinor,
    })
    .onConflictDoUpdate({
      target: [cartItems.cartId, cartItems.variantId],
      set: {
        quantity: sql`${cartItems.quantity} + ${quantity}`,
        unitPriceMinor: row.variant.priceMinor,
      },
    });

  return cart;
}

export async function removeFromCart(cartId: string, variantId: string) {
  await db
    .delete(cartItems)
    .where(and(eq(cartItems.cartId, cartId), eq(cartItems.variantId, variantId)));
}

async function resolvePromotion(merchantId: string, code: string | undefined, subtotalMinor: number) {
  if (!code) return null;
  const [promotion] = await db
    .select()
    .from(promotions)
    .where(
      and(
        eq(promotions.merchantId, merchantId),
        eq(promotions.code, code.toUpperCase()),
        eq(promotions.active, true),
      ),
    )
    .limit(1);
  if (!promotion) return null;

  const minimum = promotion.conditions?.minSubtotalMinor ?? 0;
  if (subtotalMinor < minimum) return null;
  return promotion;
}

/**
 * Loads a cart with live catalog data and computes totals.
 *
 * Re-reads prices and stock rather than trusting what was captured at add time,
 * so a price change between adding and paying surfaces as an issue instead of
 * quietly charging the old — or new — amount.
 */
export async function loadCart(cartId: string, promoCode?: string): Promise<CartView> {
  const [cart] = await db.select().from(carts).where(eq(carts.id, cartId)).limit(1);
  if (!cart) throw new Error("Cart not found.");

  const [merchant] = await db
    .select()
    .from(merchants)
    .where(eq(merchants.id, cart.merchantId))
    .limit(1);
  const [policy] = await db
    .select()
    .from(merchantPolicies)
    .where(eq(merchantPolicies.merchantId, cart.merchantId))
    .limit(1);

  const rows = await db
    .select({
      item: cartItems,
      variant: productVariants,
      product: products,
      available: sql<number>`GREATEST(COALESCE(${inventory.quantity},0) - COALESCE(${inventory.reserved},0), 0)`,
    })
    .from(cartItems)
    .innerJoin(productVariants, eq(productVariants.id, cartItems.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(inventory, eq(inventory.variantId, productVariants.id))
    .where(eq(cartItems.cartId, cartId));

  const issues: CartIssue[] = [];
  const lines: CartLine[] = rows.map(({ item, variant, product, available }) => {
    const line: CartLine = {
      cartItemId: item.id,
      variantId: variant.id,
      productId: product.id,
      title: product.title,
      sku: variant.sku,
      attributes: variant.attributes,
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
      currentPriceMinor: variant.priceMinor,
      availableQuantity: Number(available),
      active: variant.active && product.status === "active",
    };

    if (!line.active) {
      issues.push({ variantId: variant.id, kind: "inactive", detail: `${product.title} is no longer for sale.` });
    } else if (line.availableQuantity === 0) {
      issues.push({ variantId: variant.id, kind: "out_of_stock", detail: `${product.title} is out of stock.` });
    } else if (line.availableQuantity < line.quantity) {
      issues.push({
        variantId: variant.id,
        kind: "insufficient_stock",
        detail: `Only ${line.availableQuantity} of ${product.title} left, you asked for ${line.quantity}.`,
      });
    }

    if (line.currentPriceMinor !== line.unitPriceMinor) {
      issues.push({
        variantId: variant.id,
        kind: "price_changed",
        detail:
          `${product.title} changed from ${formatMoney(line.unitPriceMinor)} to ` +
          `${formatMoney(line.currentPriceMinor)} since you added it.`,
      });
    }
    return line;
  });

  // Totals always use the CURRENT price — never a stale captured one.
  const subtotalMinor = lines.reduce((sum, l) => sum + l.currentPriceMinor * l.quantity, 0);
  const promotion = await resolvePromotion(cart.merchantId, promoCode, subtotalMinor);

  let discountMinor = 0;
  let freeShipping = false;
  if (promotion) {
    if (promotion.type === "percentage_off") discountMinor = applyBp(subtotalMinor, promotion.value);
    else if (promotion.type === "flat_off") discountMinor = Math.min(promotion.value, subtotalMinor);
    else if (promotion.type === "free_shipping") freeShipping = true;
  }

  const freeAbove = policy?.freeShippingAboveMinor ?? null;
  const shippingMinor =
    lines.length === 0 || freeShipping || (freeAbove !== null && subtotalMinor - discountMinor >= freeAbove)
      ? 0
      : (policy?.flatShippingMinor ?? 0);

  const taxMinor = applyBp(subtotalMinor - discountMinor, TAX_BP);

  return {
    cartId,
    merchant: { id: merchant.id, slug: merchant.slug, name: merchant.name },
    lines,
    issues,
    appliedPromotion: promotion
      ? { id: promotion.id, code: promotion.code, title: promotion.title }
      : null,
    totals: {
      subtotalMinor,
      discountMinor,
      shippingMinor,
      taxMinor,
      totalMinor: subtotalMinor - discountMinor + shippingMinor + taxMinor,
      currency: policy?.currency ?? "INR",
    },
  };
}

/** Holds stock for an in-flight checkout so two shoppers cannot buy the last unit. */
export async function reserveStock(lines: CartLine[]): Promise<{ ok: boolean; failure?: string }> {
  for (const line of lines) {
    const updated = await db
      .update(inventory)
      .set({ reserved: sql`${inventory.reserved} + ${line.quantity}`, updatedAt: new Date() })
      .where(
        and(
          eq(inventory.variantId, line.variantId),
          sql`${inventory.quantity} - ${inventory.reserved} >= ${line.quantity}`,
        ),
      )
      .returning({ variantId: inventory.variantId });

    if (updated.length === 0) {
      // Roll back everything reserved so far — no partial holds.
      await releaseStock(lines.slice(0, lines.indexOf(line)));
      return { ok: false, failure: `${line.title} sold out while you were checking out.` };
    }
  }
  return { ok: true };
}

export async function releaseStock(lines: CartLine[]) {
  for (const line of lines) {
    await db
      .update(inventory)
      .set({
        reserved: sql`GREATEST(${inventory.reserved} - ${line.quantity}, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(inventory.variantId, line.variantId));
  }
}

/** Converts a reservation into a real stock decrement once payment succeeds. */
export async function commitStock(lines: CartLine[]) {
  for (const line of lines) {
    await db
      .update(inventory)
      .set({
        quantity: sql`GREATEST(${inventory.quantity} - ${line.quantity}, 0)`,
        reserved: sql`GREATEST(${inventory.reserved} - ${line.quantity}, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(inventory.variantId, line.variantId));
  }
}

export async function markCartConverted(cartId: string) {
  await db.update(carts).set({ status: "converted", updatedAt: new Date() }).where(eq(carts.id, cartId));
}

export async function clearCart(cartId: string) {
  await db.delete(cartItems).where(eq(cartItems.cartId, cartId));
}

export async function listOpenCartIds(userId: string) {
  const rows = await db
    .select({ id: carts.id })
    .from(carts)
    .where(and(eq(carts.userId, userId), eq(carts.status, "open")));
  return rows.map((r) => r.id);
}

export async function cartsForVariants(variantIds: string[]) {
  if (variantIds.length === 0) return [];
  return db.select().from(cartItems).where(inArray(cartItems.variantId, variantIds));
}

/**
 * Buy-now: makes the cart contain exactly this item.
 *
 * When a shopper picks an option out of the agent's ranked results they mean
 * "buy this one", not "append this to everything I have ever looked at".
 * Appending silently turned a ₹4,299 pair of shoes into a ₹20,291 order, so
 * selection replaces the open cart rather than adding to it.
 */
export async function startDirectPurchase(input: {
  userId: string;
  variantId: string;
  quantity?: number;
  agentSessionId?: string;
}) {
  const [row] = await db
    .select({ merchantId: products.merchantId })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(productVariants.id, input.variantId))
    .limit(1);
  if (!row) throw new Error("That product variant no longer exists.");

  const cart = await getOrCreateCart(input.userId, row.merchantId, input.agentSessionId);
  await db.delete(cartItems).where(eq(cartItems.cartId, cart.id));

  return addToCart(input);
}

/** Sets an exact line quantity, removing the line at zero. */
export async function setLineQuantity(input: {
  userId: string;
  cartId: string;
  variantId: string;
  quantity: number;
}): Promise<{ ok: true } | { error: string }> {
  const [cart] = await db
    .select({ id: carts.id })
    .from(carts)
    .where(and(eq(carts.id, input.cartId), eq(carts.userId, input.userId)))
    .limit(1);
  if (!cart) return { error: "That cart is not yours." };

  if (input.quantity <= 0) {
    await removeFromCart(input.cartId, input.variantId);
    return { ok: true };
  }

  const [row] = await db
    .select({
      available: sql<number>`GREATEST(COALESCE(${inventory.quantity},0) - COALESCE(${inventory.reserved},0), 0)`,
      price: productVariants.priceMinor,
      active: productVariants.active,
    })
    .from(productVariants)
    .leftJoin(inventory, eq(inventory.variantId, productVariants.id))
    .where(eq(productVariants.id, input.variantId))
    .limit(1);

  if (!row?.active) return { error: "That option is no longer for sale." };
  if (Number(row.available) < input.quantity) {
    return {
      error:
        Number(row.available) === 0
          ? "That option is out of stock."
          : `Only ${row.available} left in stock.`,
    };
  }

  await db
    .update(cartItems)
    .set({ quantity: input.quantity, unitPriceMinor: row.price })
    .where(and(eq(cartItems.cartId, input.cartId), eq(cartItems.variantId, input.variantId)));

  return { ok: true };
}

export type CartSummary = {
  cartId: string;
  merchant: { id: string; slug: string; name: string };
  itemCount: number;
  totals: Totals;
  issues: CartIssue[];
  lines: CartLine[];
};

/**
 * Every open cart, one per merchant.
 *
 * Carts are per-merchant because checkout, the Cart Mandate and fulfilment all
 * are: a single basket spanning three merchants cannot be signed, charged or
 * shipped as one order. Adding from a second merchant opens a second cart
 * rather than producing a basket that cannot be paid for.
 */
export async function getOpenCarts(userId: string): Promise<CartSummary[]> {
  const open = await db
    .select({ id: carts.id })
    .from(carts)
    .where(and(eq(carts.userId, userId), eq(carts.status, "open")));

  const summaries: CartSummary[] = [];
  for (const { id } of open) {
    const view = await loadCart(id);
    if (view.lines.length === 0) continue;
    summaries.push({
      cartId: view.cartId,
      merchant: view.merchant,
      itemCount: view.lines.reduce((sum, l) => sum + l.quantity, 0),
      totals: view.totals,
      issues: view.issues,
      lines: view.lines,
    });
  }
  return summaries;
}

/** Total units across every open cart — for the nav badge. */
export async function getCartItemCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`COALESCE(SUM(${cartItems.quantity}), 0)` })
    .from(cartItems)
    .innerJoin(carts, eq(carts.id, cartItems.cartId))
    .where(and(eq(carts.userId, userId), eq(carts.status, "open")));
  return Number(row?.n ?? 0);
}
