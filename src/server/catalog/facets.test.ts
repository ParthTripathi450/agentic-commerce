import { describe, expect, it } from "vitest";
import { bucketsFromPrices, computeFacets } from "./facets";
import { hybridSearch } from "./search";

/**
 * Suggestion chips are a promise.
 *
 * Tapping one must lead to something that can be bought today, so every value
 * offered is counted from live variants and live inventory.
 */

describe("bucketsFromPrices", () => {
  it("returns nothing for an empty catalogue rather than an empty band", () => {
    expect(bucketsFromPrices([])).toEqual([]);
  });

  it("collapses to one band when everything costs about the same", () => {
    // Four bands over a ₹20 spread would be noise, not a choice.
    const buckets = bucketsFromPrices([100000, 100200, 100400]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].label).toMatch(/^Around /);
  });

  it("never shows a band with nothing in it", () => {
    const prices = [10000, 20000, 30000, 40000, 50000, 60000, 70000, 80000];
    for (const bucket of bucketsFromPrices(prices)) {
      expect(bucket.count).toBeGreaterThan(0);
    }
  });

  it("covers the whole range: every price falls in exactly one band", () => {
    const prices = [1000, 5000, 9000, 15000, 40000, 90000, 250000];
    const buckets = bucketsFromPrices(prices);
    for (const price of prices) {
      const matching = buckets.filter(
        (b) => (b.minMinor === null || price > b.minMinor) && (b.maxMinor === null || price <= b.maxMinor),
      );
      expect(matching).toHaveLength(1);
    }
  });

  it("bands are contiguous and ascending", () => {
    const buckets = bucketsFromPrices([1000, 5000, 9000, 15000, 40000, 90000, 250000]);
    expect(buckets[0].minMinor).toBeNull();
    expect(buckets[buckets.length - 1].maxMinor).toBeNull();
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].minMinor).toBe(buckets[i - 1].maxMinor);
    }
  });
});

describe("computeFacets", () => {
  it("offers nothing for an empty product set", async () => {
    const facets = await computeFacets([]);
    expect(facets.attributes).toEqual({});
    expect(facets.priceBuckets).toEqual([]);
  });

  it("counts only variants that are active and in stock", async () => {
    const search = await hybridSearch({ text: "road running shoes", limit: 40, requireInStock: true });
    const facets = await computeFacets(search.candidates.map((c) => c.productId));

    expect(facets.inStockVariants).toBeGreaterThan(0);
    expect(facets.attributes.color?.length).toBeGreaterThan(0);
    expect(facets.attributes.size?.length).toBeGreaterThan(0);
    for (const value of facets.attributes.color ?? []) {
      expect(value.count).toBeGreaterThan(0);
    }
  });

  it("scopes facets to the products searched, not the whole catalogue", async () => {
    // "100ml" is a drinkware size and must never be offered as a shoe size.
    const search = await hybridSearch({ text: "football boots firm ground", limit: 40, requireInStock: true });
    const facets = await computeFacets(search.candidates.map((c) => c.productId));
    const sizes = (facets.attributes.size ?? []).map((s) => s.value);
    expect(sizes).not.toContain("100ml");
  });

  it("derives price bands from the real distribution", async () => {
    const search = await hybridSearch({ text: "road running shoes", limit: 40, requireInStock: true });
    const facets = await computeFacets(search.candidates.map((c) => c.productId));

    expect(facets.priceBuckets.length).toBeGreaterThan(1);
    expect(facets.priceRange).not.toBeNull();
    expect(facets.priceRange!.minMinor).toBeLessThan(facets.priceRange!.maxMinor);
  });
});
