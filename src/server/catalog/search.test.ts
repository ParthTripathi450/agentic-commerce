import { describe, expect, it } from "vitest";
import { hybridSearch, type StructuredQuery } from "./search";

/**
 * Integration tests against the seeded local database.
 * Run `npm run db:seed && npm run catalog:index` first.
 */

const RUNNING_SHOES_QUERY: StructuredQuery = {
  text: "black running shoes for daily road training",
  attributes: { color: "black", size: "10" },
  priceMaxMinor: 500000, // ₹5,000
  requireInStock: true,
  limit: 10,
};

describe("hybridSearch", () => {
  it("respects every hard constraint it was given", async () => {
    const { candidates } = await hybridSearch(RUNNING_SHOES_QUERY);

    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.variant.attributes.color).toBe("black");
      expect(c.variant.attributes.size).toBe("10");
      expect(c.variant.priceMinor).toBeLessThanOrEqual(500000);
      expect(c.variant.availableQuantity).toBeGreaterThan(0);
    }
  });

  it("searches across multiple merchants rather than one storefront", async () => {
    const { candidates, stats } = await hybridSearch(RUNNING_SHOES_QUERY);
    const merchants = new Set(candidates.map((c) => c.merchant.slug));
    expect(merchants.size).toBeGreaterThan(1);
    expect(stats.merchantsSearched).toBeGreaterThan(1);
  });

  it("surfaces the in-stock Velocity Run 3 at Stride Athletics", async () => {
    const { candidates } = await hybridSearch(RUNNING_SHOES_QUERY);
    const match = candidates.find(
      (c) => c.merchant.slug === "stride-athletics" && c.title.includes("Velocity Run 3"),
    );
    expect(match).toBeDefined();
    expect(match!.variant.priceMinor).toBe(429900);
  });

  it("records WHY each excluded product was excluded", async () => {
    const { rejected } = await hybridSearch(RUNNING_SHOES_QUERY);

    // Cheaper, matches the query exactly — but has no stock in size 10.
    const outOfStock = rejected.find(
      (r) => r.merchantSlug === "budget-bazaar" && r.title.includes("Velocity Run 3"),
    );
    expect(outOfStock?.reason).toBe("out_of_stock");

    // Right category and colour, but priced far above the stated budget.
    const overBudget = rejected.find((r) => r.title.includes("Tempo Race Elite"));
    expect(overBudget?.reason).toBe("over_budget");
    expect(overBudget?.observedPriceMinor).toBeGreaterThan(500000);
  });

  it("returns the out-of-stock product when the stock constraint is lifted", async () => {
    const { candidates } = await hybridSearch({
      ...RUNNING_SHOES_QUERY,
      requireInStock: false,
    });
    const budget = candidates.find(
      (c) => c.merchant.slug === "budget-bazaar" && c.title.includes("Velocity Run 3"),
    );
    expect(budget).toBeDefined();
  });

  it("rejects products that lack the requested variant entirely", async () => {
    const { candidates, rejected } = await hybridSearch({
      ...RUNNING_SHOES_QUERY,
      attributes: { color: "black", size: "15" },
    });
    expect(candidates).toHaveLength(0);
    expect(rejected.some((r) => r.reason === "attribute_mismatch")).toBe(true);
  });
});

describe("relevance gate", () => {
  it("does not return unrelated products just because they are cheap", async () => {
    // Regression: a ₹999 t-shirt used to outrank headphones, because relevance
    // was only a weighted criterion rather than a precondition.
    const { candidates, rejected } = await hybridSearch({
      text: "noise cancelling headphones",
      priceMaxMinor: 900000,
      requireInStock: true,
      limit: 5,
    });

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(
        /headphone|earbud|audio/i.test(`${candidate.title} ${candidate.category}`),
        `unrelated product surfaced: ${candidate.title}`,
      ).toBe(true);
    }

    // The irrelevant ones are reported with a reason, not silently dropped.
    const irrelevant = rejected.filter((r) => r.reason === "not_relevant");
    expect(irrelevant.length).toBeGreaterThan(0);
    expect(irrelevant[0].detail).toMatch(/close enough/i);
  });

  it("still returns the full set for a well-matched query", async () => {
    const { candidates } = await hybridSearch(RUNNING_SHOES_QUERY);
    // The gate must not strangle a query where everything is genuinely relevant.
    expect(candidates.length).toBeGreaterThan(2);
    expect(candidates.some((c) => c.title.includes("Velocity Run 3"))).toBe(true);
  });
});

describe("no-hallucination guard", () => {
  it("returns nothing at all for a product this marketplace does not sell", async () => {
    // Measured separation on this catalogue: stocked items score 0.369-0.721,
    // unstocked queries top out at 0.307. Anything below the floor must return
    // nothing rather than the nearest unrelated product.
    for (const query of ["electric guitar", "diamond engagement ring", "washing machine"]) {
      const result = await hybridSearch({ text: query, requireInStock: true, limit: 5 });

      expect(result.candidates, `"${query}" should return nothing`).toHaveLength(0);
      expect(result.noRelevantMatch, `"${query}" should flag no relevant match`).toBe(true);
    }
  });

  it("still answers normally for things that are stocked", async () => {
    for (const [query, expected] of [
      ["yoga mat", /yoga mat/i],
      ["noise cancelling headphones", /headphone|earbud/i],
      ["running shoes", /running shoes/i],
    ] as const) {
      const result = await hybridSearch({ text: query, requireInStock: true, limit: 5 });

      expect(result.noRelevantMatch, `"${query}" should not be flagged irrelevant`).toBe(false);
      expect(result.candidates.length, `"${query}" should return results`).toBeGreaterThan(0);
      expect(result.candidates[0].title).toMatch(expected);
    }
  });

  it("reports how close the best match was, so the threshold is auditable", async () => {
    const stocked = await hybridSearch({ text: "yoga mat", requireInStock: true });
    const absent = await hybridSearch({ text: "electric guitar", requireInStock: true });

    expect(stocked.stats.topRelevance).toBeGreaterThan(absent.stats.topRelevance);
    expect(absent.stats.topRelevance).toBeLessThan(0.34);
  });
});
