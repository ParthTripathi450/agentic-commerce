import { describe, expect, it } from "vitest";
import { hybridSearch } from "@/server/catalog/search";
import type { Candidate } from "@/server/catalog/search";
import {
  describeDifferences,
  differenceDistance,
  findAlternatives,
  rankByCloseness,
} from "./alternatives";
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
    const far = { candidate: candidate(), differences: ["a", "b", "c"], distance: 12 };
    const near = { candidate: candidate(), differences: ["a"], distance: 1 };
    expect(rankByCloseness([far, near])[0]).toBe(near);
  });

  it("breaks ties on retrieval relevance", () => {
    const weak = { candidate: candidate({ retrieval: { vectorScore: 0, lexicalScore: 0, rrf: 0.01 } }), differences: ["a"], distance: 1 };
    const strong = { candidate: candidate({ retrieval: { vectorScore: 0, lexicalScore: 0, rrf: 0.05 } }), differences: ["a"], distance: 1 };
    expect(rankByCloseness([weak, strong])[0]).toBe(strong);
  });

  it("prefers the right product in the wrong colour over the wrong product in the right colour", () => {
    // The complaint this ordering exists to answer. Counting differences got
    // it backwards: a navy rucksack offered against "navy running shoes"
    // matches on colour and so has FEWER differences than the same running
    // shoe in black, and used to be ranked first.
    const rightThingWrongColour = {
      candidate: candidate({ category: "Running Shoes" }),
      differences: ["no colour navy — available in black, white"],
      distance: 1,
    };
    const wrongThingRightColour = {
      candidate: candidate({ category: "Backpacks" }),
      differences: ["a backpack, not what you were looking at"],
      distance: 100,
    };

    const ranked = rankByCloseness([wrongThingRightColour, rightThingWrongColour]);
    expect(ranked[0]).toBe(rightThingWrongColour);
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

describe("differenceDistance — colour must never outrank product kind", () => {
  /** "navy running shoes" — the exact request the complaint was about. */
  const wantsNavy = (over: Partial<ShoppingIntent> = {}) =>
    intent({ attributes: { color: "navy" }, ...over });

  it("costs a different category far more than a different colour", () => {
    const sameKind = candidate({ category: "Running Shoes" });
    sameKind.variant.attributes = { color: "black", size: "9" };

    const otherKind = candidate({ category: "Backpacks" });
    otherKind.variant.attributes = { color: "navy", size: "one" };

    const anchors = ["Running Shoes"];
    expect(differenceDistance(wantsNavy(), sameKind, anchors)).toBeLessThan(
      differenceDistance(wantsNavy(), otherKind, anchors),
    );
  });

  it("cannot be bought back by matching every soft attribute", () => {
    // Even a wrong-category product that matches colour, style AND width must
    // stay behind a right-category product that matches none of them.
    const wrongKind = candidate({ category: "Backpacks" });
    wrongKind.variant.attributes = { color: "navy", style: "casual", width: "regular" };

    const rightKind = candidate({ category: "Running Shoes" });
    rightKind.variant.attributes = { color: "red", style: "sport", width: "wide" };

    const asked = wantsNavy({ attributes: { color: "navy", style: "casual", width: "regular" } });
    const anchors = ["Running Shoes"];

    expect(differenceDistance(asked, rightKind, anchors)).toBeLessThan(
      differenceDistance(asked, wrongKind, anchors),
    );
  });

  it("says the category mismatch out loud rather than hiding it", () => {
    const otherKind = candidate({ category: "Backpacks" });
    otherKind.variant.attributes = { color: "navy" };

    const lines = describeDifferences(wantsNavy(), otherKind, {}, ["Running Shoes"]);
    expect(lines.join(" ")).toContain("backpacks");
  });

  it("charges nothing for category when there is no anchor to compare against", () => {
    const any = candidate({ category: "Backpacks" });
    any.variant.attributes = { color: "navy" };
    expect(differenceDistance(wantsNavy(), any, [])).toBe(0);
  });
});
