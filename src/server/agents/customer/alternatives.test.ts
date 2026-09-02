import { describe, expect, it } from "vitest";
import { hybridSearch } from "@/server/catalog/search";
import type { Candidate } from "@/server/catalog/search";
import { describeDifferences, findAlternatives, rankByCloseness } from "./alternatives";
import { intentToQuery } from "./intent";
import { shoppingIntentSchema, type ShoppingIntent } from "./intent-schema";

/**
 * Selling a substitute, honestly.
 *
 * Two properties carry the whole feature: a substitute is NEVER offered when
 * the catalogue does not stock the kind of thing asked for, and a substitute is
 * NEVER shown without saying how it differs.
 */

const intent = (over: Partial<ShoppingIntent> = {}): ShoppingIntent =>
  shoppingIntentSchema.parse({ productQuery: "running shoes", ...over });

const candidate = (over: Partial<Candidate> = {}): Candidate =>
  ({
    productId: "p1",
    title: "Velocity Run 3",
    description: "",
    brand: "Stride",
    category: "Running Shoes",
    attributes: {},
    imageUrls: [],
    ratingBp: 4500,
    ratingCount: 100,
    merchant: { id: "m1", slug: "stride", name: "Stride", fulfillmentRateBp: 9500, avgDispatchHours: 24 },
    policies: {
      returnWindowDays: 14, returnsAccepted: true, standardDeliveryDays: 3,
      flatShippingMinor: 0, freeShippingAboveMinor: null,
    },
    variant: {
      id: "v1", sku: "SKU", attributes: { size: "9", color: "navy" },
      priceMinor: 429900, compareAtPriceMinor: null, currency: "INR", availableQuantity: 5,
    },
    retrieval: { vectorScore: 0.8, lexicalScore: 0.5, rrf: 0.03 },
    ...over,
  }) as Candidate;

describe("describeDifferences", () => {
  it("states the real available values when it knows them", () => {
    const d = describeDifferences(
      intent({ attributes: { size: "15" } }),
      candidate(),
      { size: ["7", "8", "9", "10", "11"] },
    );
    expect(d).toEqual(["no size 15 — available in 7, 8, 9, 10, 11"]);
  });

  it("says what the variant IS when it cannot list availability", () => {
    const d = describeDifferences(intent({ attributes: { color: "black" } }), candidate());
    expect(d).toEqual(["color is navy, not black"]);
  });

  it("quantifies how far over budget, not just that it is over", () => {
    const d = describeDifferences(intent({ priceMaxMinor: 300000 }), candidate());
    expect(d[0]).toContain("₹4,299");
    expect(d[0]).toContain("over your ₹3,000 budget");
  });

  it("reports a different brand", () => {
    const d = describeDifferences(intent({ brand: "Arcus" }), candidate());
    expect(d).toEqual(["by Stride, not Arcus"]);
  });

  it("reports NOTHING when the candidate actually matches", () => {
    // An empty list is what stops a true match being mislabelled a substitute.
    const d = describeDifferences(
      intent({ attributes: { size: "9", color: "navy" }, priceMaxMinor: 500000 }),
      candidate(),
    );
    expect(d).toEqual([]);
  });

  it("is case-insensitive about a matching attribute", () => {
    expect(describeDifferences(intent({ attributes: { color: "NAVY" } }), candidate())).toEqual([]);
  });

  it("accumulates every difference rather than stopping at the first", () => {
    const d = describeDifferences(
      intent({ attributes: { color: "black" }, priceMaxMinor: 300000, brand: "Arcus" }),
      candidate(),
    );
    expect(d).toHaveLength(3);
  });
});

describe("rankByCloseness", () => {
  it("puts the least-compromised substitute first", () => {
    const far = { candidate: candidate(), differences: ["a", "b", "c"] };
    const near = { candidate: candidate(), differences: ["a"] };
    expect(rankByCloseness([far, near])[0]).toBe(near);
  });

  it("breaks ties on retrieval relevance", () => {
    const weak = { candidate: candidate({ retrieval: { vectorScore: 0, lexicalScore: 0, rrf: 0.01 } }), differences: ["a"] };
    const strong = { candidate: candidate({ retrieval: { vectorScore: 0, lexicalScore: 0, rrf: 0.05 } }), differences: ["a"] };
    expect(rankByCloseness([weak, strong])[0]).toBe(strong);
  });
});

describe("findAlternatives — the guard", () => {
  it("offers nothing when the catalogue does not stock the KIND of thing", async () => {
    // The §6 anti-hallucination line: suggesting shoes here would be the bug.
    const i = intent({ productQuery: "gaming laptop with RTX graphics" });
    const query = intentToQuery(i, { limit: 10 });
    const search = await hybridSearch(query);
    expect(search.noRelevantMatch).toBe(true);

    const result = await findAlternatives({ intent: i, query, search });
    expect(result.alternatives).toEqual([]);
  });

  it("offers nothing when the exact request already succeeded", async () => {
    const i = intent({ productQuery: "road running shoes" });
    const query = intentToQuery(i, { limit: 10 });
    const search = await hybridSearch(query);
    expect(search.candidates.length).toBeGreaterThan(0);

    const result = await findAlternatives({ intent: i, query, search });
    expect(result.alternatives).toEqual([]);
  });

  it("offers buyable near-misses when only a filter blocked the sale", async () => {
    const i = intent({ productQuery: "road running shoes", attributes: { size: "15" } });
    const query = intentToQuery(i, { limit: 10 });
    const search = await hybridSearch(query);
    expect(search.candidates).toHaveLength(0);
    expect(search.noRelevantMatch).toBe(false);

    const result = await findAlternatives({ intent: i, query, search, limit: 4 });
    expect(result.alternatives.length).toBeGreaterThan(0);
    expect(result.dropped).toContain("size 15");

    for (const a of result.alternatives) {
      // Never silently substituted...
      expect(a.differences.length).toBeGreaterThan(0);
      // ...and never unsellable.
      expect(a.candidate.variant.availableQuantity).toBeGreaterThan(0);
    }
  });
});
