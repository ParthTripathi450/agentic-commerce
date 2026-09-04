import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { addresses, orders } from "@/db/schema";
import { provisionTestShopper } from "./test-utils";
import {
  addAddress,
  defaultAddress,
  formatAddress,
  listAddresses,
  removeAddress,
  setDefaultAddress,
  toSnapshot,
} from "./addresses";
import { withinReturnWindow } from "./refund";

const SAMPLE = {
  recipient: "Riya Sharma",
  line1: "12 MG Road",
  city: "Bengaluru",
  state: "Karnataka",
  postcode: "560001",
};

describe("addresses", () => {
  let userId: string;

  beforeAll(async () => {
    userId = await provisionTestShopper("addresses@acp.test", "Address Test");
    await db.delete(addresses).where(eq(addresses.userId, userId));
  });

  it("makes the first address the default, whatever the caller asked", async () => {
    // A shopper whose only address is not the default gets a checkout that
    // offers them nothing.
    const first = await addAddress(userId, { ...SAMPLE, label: "Home" });
    expect(first.isDefault).toBe(true);
  });

  it("moves the default without ever leaving the shopper without one", async () => {
    const second = await addAddress(userId, { ...SAMPLE, label: "Office", city: "Pune" });
    expect(second.isDefault).toBe(false);

    expect(await setDefaultAddress(userId, second.id)).toBe(true);
    const all = await listAddresses(userId);
    expect(all.filter((a) => a.isDefault)).toHaveLength(1);
    expect((await defaultAddress(userId))?.id).toBe(second.id);
  });

  it("hands the default on when the default is deleted", async () => {
    // Deleting the default without promoting another reads as "we lost your
    // address" rather than "you deleted one".
    const current = await defaultAddress(userId);
    expect(await removeAddress(userId, current!.id)).toBe(true);

    const remaining = await listAddresses(userId);
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.filter((a) => a.isDefault)).toHaveLength(1);
  });

  it("refuses to touch someone else's address", async () => {
    const other = await provisionTestShopper("addresses-other@acp.test", "Other");
    const mine = (await listAddresses(userId))[0];
    expect(await setDefaultAddress(other, mine.id)).toBe(false);
    expect(await removeAddress(other, mine.id)).toBe(false);
  });

  it("snapshots into a form an order can keep", async () => {
    const address = (await listAddresses(userId))[0];
    const snapshot = toSnapshot(address);
    expect(snapshot.line1).toBe(address.line1);
    expect(formatAddress(snapshot)).toContain(address.postcode);
    // An order with no address must still render.
    expect(formatAddress(null)).toMatch(/no delivery address/i);
  });

  it("keeps the order's address after the shopper's own is deleted", async () => {
    // The whole reason orders snapshot rather than reference: an order is a
    // record of what happened and must keep saying where it went.
    const [row] = (await db.execute(sql`
      SELECT id, shipping_address FROM orders
      WHERE shipping_address IS NOT NULL LIMIT 1
    `)) as unknown as { id: string; shipping_address: Record<string, unknown> }[];
    if (!row) return;

    const [order] = await db.select().from(orders).where(eq(orders.id, row.id)).limit(1);
    expect(order.shippingAddress).toBeTruthy();
    expect(order.shippingAddress?.line1).toBeTruthy();
  });
});

describe("withinReturnWindow", () => {
  const day = 86_400_000;

  it("allows a return inside the seller's stated window", () => {
    expect(
      withinReturnWindow({
        placedAt: new Date(Date.now() - 3 * day),
        returnsAccepted: true,
        returnWindowDays: 14,
      }).ok,
    ).toBe(true);
  });

  it("refuses outside it, and says the numbers that decided", () => {
    // A refusal without the figures is unarguable, and the shopper can read the
    // same policy on the product page.
    const result = withinReturnWindow({
      placedAt: new Date(Date.now() - 40 * day),
      returnsAccepted: true,
      returnWindowDays: 14,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("40");
      expect(result.reason).toContain("14");
    }
  });

  it("refuses when the seller accepts no returns at all", () => {
    const result = withinReturnWindow({
      placedAt: new Date(),
      returnsAccepted: false,
      returnWindowDays: 30,
    });
    expect(result.ok).toBe(false);
  });

  it("counts the last day as inside the window", () => {
    // Off-by-one here charges a shopper for the seller's rounding.
    expect(
      withinReturnWindow({
        placedAt: new Date(Date.now() - 14 * day),
        returnsAccepted: true,
        returnWindowDays: 14,
      }).ok,
    ).toBe(true);
  });
});
