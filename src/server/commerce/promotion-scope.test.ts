import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { promotions } from "@/db/schema";
import { carts, cartItems } from "@/db/schema";
import { loadCart } from "./cart";
import { emptyOpenCarts, ensureStock, provisionTestShopper } from "./test-utils";

/**
 * A promotion that says "shoes only, ends Friday" has to mean it.
 *
 * Both conditions existed in the schema and were ignored by the cart, so every
 * scoped or expired offer discounted the whole basket forever. A merchant
 * setting a scope and watching it do nothing is worse than not offering it.
 */
describe("promotion scope and validity", () => {
  let userId: string;

  beforeAll(async () => {
    userId = await provisionTestShopper("promo-scope@acp.test", "Promo Scope");
    await emptyOpenCarts(userId);
  });

  /*
   * The cart is built with plain inserts rather than through `addToCart`.
   *
   * That lives in a `"use server"` module, which imports next-auth, which
   * cannot load under Vitest (§8.14) — importing it fails the whole file before
   * a single test runs.
   */
  async function cartWithOneProduct() {
    const variant = await db.query.productVariants.findFirst({
      with: { product: true },
      where: (v, { eq: matches }) => matches(v.active, true),
    });
    if (!variant) return null;
    await ensureStock(variant.id, 5);
    await emptyOpenCarts(userId);

    const [cart] = await db
      .insert(carts)
      .values({ userId, merchantId: variant.product.merchantId, status: "open" })
      .returning();
    await db.insert(cartItems).values({
      cartId: cart.id,
      variantId: variant.id,
      quantity: 1,
      unitPriceMinor: variant.priceMinor,
    });

    return { cartId: cart.id, product: variant.product, merchantId: variant.product.merchantId };
  }

  it("does not apply when the cart holds none of the scoped categories", async () => {
    const setup = await cartWithOneProduct();
    if (!setup) return;

    const [promo] = await db
      .insert(promotions)
      .values({
        merchantId: setup.merchantId,
        title: "Scoped elsewhere",
        code: "SCOPETEST",
        type: "percentage_off",
        value: 2000,
        conditions: { categories: ["A Category Nobody Stocks"] },
        active: true,
        activeFrom: new Date(Date.now() - 86_400_000),
        activeTo: null,
      })
      .returning();

    const cart = await loadCart(setup.cartId, "SCOPETEST");
    expect(cart.totals.discountMinor).toBe(0);

    await db.delete(promotions).where(eq(promotions.id, promo.id));
  });

  it("applies when the cart does hold the scoped category", async () => {
    const setup = await cartWithOneProduct();
    if (!setup) return;

    const [promo] = await db
      .insert(promotions)
      .values({
        merchantId: setup.merchantId,
        title: "Scoped here",
        code: "SCOPEHIT",
        type: "percentage_off",
        value: 1000,
        conditions: { categories: [setup.product.category] },
        active: true,
        activeFrom: new Date(Date.now() - 86_400_000),
        activeTo: null,
      })
      .returning();

    const cart = await loadCart(setup.cartId, "SCOPEHIT");
    expect(cart.totals.discountMinor).toBeGreaterThan(0);

    await db.delete(promotions).where(eq(promotions.id, promo.id));
  });

  it("ignores a promotion whose window has closed", async () => {
    // `active` is the merchant's switch; the dates are the offer's own terms,
    // and only the switch was ever being read.
    const setup = await cartWithOneProduct();
    if (!setup) return;

    const [promo] = await db
      .insert(promotions)
      .values({
        merchantId: setup.merchantId,
        title: "Finished last week",
        code: "EXPIREDTEST",
        type: "percentage_off",
        value: 5000,
        conditions: {},
        active: true,
        activeFrom: new Date(Date.now() - 30 * 86_400_000),
        activeTo: new Date(Date.now() - 7 * 86_400_000),
      })
      .returning();

    const cart = await loadCart(setup.cartId, "EXPIREDTEST");
    expect(cart.totals.discountMinor).toBe(0);

    await db.delete(promotions).where(eq(promotions.id, promo.id));
  });

  it("ignores a promotion that has not started", async () => {
    const setup = await cartWithOneProduct();
    if (!setup) return;

    const [promo] = await db
      .insert(promotions)
      .values({
        merchantId: setup.merchantId,
        title: "Starts next month",
        code: "FUTURETEST",
        type: "flat_off",
        value: 10_000,
        conditions: {},
        active: true,
        activeFrom: new Date(Date.now() + 30 * 86_400_000),
        activeTo: null,
      })
      .returning();

    const cart = await loadCart(setup.cartId, "FUTURETEST");
    expect(cart.totals.discountMinor).toBe(0);

    await db
      .delete(promotions)
      .where(and(eq(promotions.id, promo.id), eq(promotions.merchantId, setup.merchantId)));
  });
});
