import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { shopperSignals } from "@/db/schema";
import { affinityFor } from "@/server/agents/customer/affinity";
import { provisionTestShopper } from "@/server/commerce/test-utils";
import { buildKnowledgeBase, describeKnowledge, toTasteProfile } from "./knowledge";
import { deleteShopperSignals, recordProductView, recordSearch } from "./signals";

describe("shopper knowledge base", () => {
  let userId: string;

  beforeAll(async () => {
    userId = await provisionTestShopper("knowledge@acp.test", "Knowledge Base Test");
    await deleteShopperSignals(userId);
  });

  it("says nothing about a shopper it has no evidence for", async () => {
    const kb = await buildKnowledgeBase(userId);

    expect(kb.isEmpty).toBe(true);
    expect(kb.budget).toBeNull();
    expect(describeKnowledge(kb)).toEqual([]);
    // An empty profile must produce a taste that the ranker treats as absent,
    // rather than one that scores every product on no evidence.
    expect(toTasteProfile(kb).budget).toBeNull();
  });

  it("records a product view and collapses repeats within the dedupe window", async () => {
    const product = await db.query.products.findFirst({ columns: { id: true, category: true } });
    if (!product) throw new Error("catalogue is empty");

    await recordProductView({ userId, productId: product.id, category: product.category });
    await recordProductView({ userId, productId: product.id, category: product.category });
    await recordProductView({ userId, productId: product.id, category: product.category });

    const rows = await db
      .select({ id: shopperSignals.id })
      .from(shopperSignals)
      .where(and(eq(shopperSignals.userId, userId), eq(shopperSignals.kind, "view")));

    // Re-reading a page while comparing options is one interest, not three.
    expect(rows).toHaveLength(1);
  });

  it("keeps a browsing signal far weaker than a purchase", async () => {
    const kb = await buildKnowledgeBase(userId);
    const browsed = kb.likes.categories[0];

    // A single view is worth 1 against a purchase's 4, which is below the
    // reporting floor — one glance at a product is not a preference.
    expect(browsed).toBeUndefined();
    expect(kb.evidence.browsed).toBe(1);
  });

  it("stores searches for context but never as a preference", async () => {
    await recordSearch(userId, "waterproof hiking boots");
    const kb = await buildKnowledgeBase(userId);

    expect(kb.recentSearches).toContain("waterproof hiking boots");
    // A search says what someone was curious about, not what they liked; it
    // must not appear as a category or brand preference on its own.
    expect(kb.likes.brands).toEqual([]);
  });

  it("never turns a preference into something that could filter results", async () => {
    const kb = await buildKnowledgeBase(userId);
    const taste = toTasteProfile(kb);

    // Whatever the profile says, an unknown product scores the neutral 0.5 —
    // there is no path from this module to excluding a product.
    const unknown = affinityFor({ brand: "Nobody At All", priceMinor: 123400 }, taste);
    expect(unknown.normalized).toBeGreaterThanOrEqual(0.5);
  });

  it("clears browsing signals without touching orders or reviews", async () => {
    const before = await buildKnowledgeBase(userId);
    const removed = await deleteShopperSignals(userId);
    const after = await buildKnowledgeBase(userId);

    expect(removed).toBeGreaterThan(0);
    expect(after.evidence.browsed).toBe(0);
    expect(after.recentSearches).toEqual([]);
    // Orders and reviews are records of real transactions and are not ours to
    // delete on a preference toggle.
    expect(after.evidence.purchases).toBe(before.evidence.purchases);
    expect(after.evidence.reviews).toBe(before.evidence.reviews);
  });
});

describe("describeKnowledge", () => {
  it("hands the model prose and never a score", async () => {
    // Same rule as `explain.ts`: a model given "brand Stride: 23.9" quotes the
    // number back at the shopper as if it meant something to them.
    const demo = await db.query.users.findFirst({
      where: (u, { eq: matches }) => matches(u.email, "demo@shopper.test"),
      columns: { id: true },
    });
    if (!demo) return;

    const lines = describeKnowledge(await buildKnowledgeBase(demo.id));
    for (const line of lines) {
      expect(line).not.toMatch(/\d+\.\d{2,}/);
    }
  });
});
