import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { orderItems, orders, productVariants } from "@/db/schema";
import { buildForYou } from "./for-you";

/**
 * The failure this page is designed against is being a mirror — showing a
 * shopper the things they have already bought, from the brand they already own.
 * These assert the three rules that prevent it.
 */
describe("buildForYou", () => {
  let demoId: string;
  let result: Awaited<ReturnType<typeof buildForYou>>;

  beforeAll(async () => {
    const demo = await db.query.users.findFirst({
      where: (u, { eq: matches }) => matches(u.email, "demo@shopper.test"),
      columns: { id: true },
    });
    demoId = demo!.id;
    result = await buildForYou(demoId);
  });

  it("builds shelves for a shopper with real history", () => {
    expect(result.isCold).toBe(false);
    expect(result.shelves.length).toBeGreaterThan(0);
  });

  it("never suggests something the shopper already owns", async () => {
    const owned = await db
      .selectDistinct({ productId: productVariants.productId })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(productVariants, eq(productVariants.id, orderItems.variantId))
      .where(and(eq(orders.userId, demoId), inArray(orders.state, ["paid", "fulfilled"])));

    const ownedIds = new Set(owned.map((o) => o.productId));
    const suggested = result.shelves.flatMap((s) => s.items.map((i) => i.productId));

    expect(suggested.length).toBeGreaterThan(0);
    expect(suggested.filter((id) => ownedIds.has(id))).toEqual([]);
  });

  it("gives every shelf a reason and every card its own", () => {
    for (const shelf of result.shelves) {
      expect(shelf.because.length).toBeGreaterThan(10);
      expect(shelf.items.length).toBeGreaterThan(0);
    }
    // At least some cards carry a per-product reason; a page where none did
    // would be merchandising wearing a personalisation label.
    const withReasons = result.shelves.flatMap((s) => s.items).filter((i) => i.reasons.length > 0);
    expect(withReasons.length).toBeGreaterThan(0);
  });

  it("leaves the shopper's usual categories on the discovery shelf", () => {
    const discover = result.shelves.find((s) => s.id === "discover");
    if (!discover) return;

    const usual = new Set(
      result.knowledge.likes.categories.slice(0, 4).map((p) => p.value),
    );
    // The one shelf that can show them something new must not quietly refill
    // with what they already buy — those score highest on every other axis.
    for (const item of discover.items) {
      expect(usual.has(item.category)).toBe(false);
    }
  });

  it("never repeats a product across shelves", () => {
    const ids = result.shelves.flatMap((s) => s.items.map((i) => i.productId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never repeats a title within a shelf", () => {
    for (const shelf of result.shelves) {
      const titles = shelf.items.map((i) => i.title.toLowerCase());
      expect(new Set(titles).size).toBe(titles.length);
    }
  });

  it("suggests only products that can actually be bought today", async () => {
    const ids = result.shelves.flatMap((s) => s.items.map((i) => i.variantId));
    if (ids.length === 0) return;

    const rows = (await db.execute(sql`
      SELECT COUNT(*) AS n FROM product_variants v
      JOIN inventory i ON i.variant_id = v.id
      WHERE v.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        AND v.active AND GREATEST(i.quantity - i.reserved, 0) > 0
    `)) as unknown as { n: string }[];

    expect(Number(rows[0].n)).toBe(ids.length);
  });

  it("says so honestly when there is nothing to go on", async () => {
    const { provisionTestShopper } = await import("@/server/commerce/test-utils");
    const coldId = await provisionTestShopper("for-you-cold@acp.test", "Cold Start");

    const cold = await buildForYou(coldId);
    // Dressing the bestseller list up as "picked for you" would be a plain lie.
    expect(cold.isCold).toBe(true);
    expect(cold.shelves).toEqual([]);
  });
});
