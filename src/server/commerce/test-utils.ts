import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agentPolicies, cartItems, carts, checkoutSessions, orders, users } from "@/db/schema";

/**
 * Provisions an isolated shopper for tests.
 *
 * Checkout tests create real orders, and those orders count toward the daily
 * spending limit — so reusing a seeded demo account makes the suite fail after
 * a few runs, and pollutes that account's history. Each run gets a dedicated
 * user whose prior orders and carts are cleared first, so daily spend starts
 * from zero and the limit logic stays under test rather than in the way.
 */
export async function provisionTestShopper(email: string, name = "Test Shopper") {
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  const user =
    existing ??
    (
      await db
        .insert(users)
        .values({ email, name, role: "customer", passwordHash: null })
        .returning()
    )[0];

  // Clear prior activity: orders cascade to items and payments; carts cascade
  // to cart items and checkout sessions.
  const priorCarts = await db.select({ id: carts.id }).from(carts).where(eq(carts.userId, user.id));
  if (priorCarts.length > 0) {
    const ids = priorCarts.map((c) => c.id);
    await db.delete(checkoutSessions).where(inArray(checkoutSessions.cartId, ids));
    await db.delete(cartItems).where(inArray(cartItems.cartId, ids));
    await db.delete(carts).where(inArray(carts.id, ids));
  }
  await db.delete(orders).where(eq(orders.userId, user.id));

  await db
    .delete(agentPolicies)
    .where(and(eq(agentPolicies.scope, "user"), eq(agentPolicies.scopeId, user.id)));
  await db.insert(agentPolicies).values({
    scope: "user",
    scopeId: user.id,
    limits: {
      maxOrderValueMinor: 40_000_00,
      maxDailySpendMinor: 90_000_00,
      maxItemsPerOrder: 10,
      requireApprovalAboveMinor: 0,
    },
  });

  return user.id;
}

/** Empties any open cart so quantities do not carry between tests. */
export async function emptyOpenCarts(userId: string) {
  const open = await db
    .select({ id: carts.id })
    .from(carts)
    .where(and(eq(carts.userId, userId), eq(carts.status, "open")));
  for (const c of open) {
    await db.delete(cartItems).where(eq(cartItems.cartId, c.id));
    await db.delete(carts).where(eq(carts.id, c.id));
  }
}

/**
 * Pins a variant's stock to a known quantity.
 *
 * Checkout tests really do commit stock, so without this the fixture depletes a
 * little on every run and the suite eventually fails with "out of stock" — a
 * true statement about the data, but nothing to do with the code under test.
 */
export async function ensureStock(variantId: string, quantity = 50) {
  const { inventory } = await import("@/db/schema");
  await db
    .insert(inventory)
    .values({ variantId, quantity, reserved: 0, lowStockThreshold: 5 })
    .onConflictDoUpdate({
      target: inventory.variantId,
      set: { quantity, reserved: 0, updatedAt: new Date() },
    });
}
