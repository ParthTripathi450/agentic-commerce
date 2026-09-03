import { describe, expect, it } from "vitest";
import { affinityFor, EMPTY_TASTE, hasTaste, type TasteProfile } from "./affinity";

const profile = (over: Partial<TasteProfile> = {}): TasteProfile => ({
  ...EMPTY_TASTE,
  ...over,
});

describe("affinityFor", () => {
  it("scores an unknown product neutrally rather than penalising it", () => {
    // The whole risk of a taste profile is that it quietly stops showing the
    // shopper anything new. A product we know nothing about must land in the
    // middle, not at the bottom of a criterion worth 15% of the score.
    const taste = profile({ brands: { stride: 1 }, categories: { "running shoes": 1 } });

    const unknown = affinityFor(
      { brand: "Nobody", category: "Cookware", priceMinor: 200000 },
      taste,
    );

    expect(unknown.normalized).toBe(0.5);
    expect(unknown.reasons).toEqual([]);
  });

  it("ranks a familiar brand above an unfamiliar one, and a panned brand below both", () => {
    const taste = profile({
      brands: { stride: 1 },
      dislikedBrands: { torvi: 1 },
    });

    const liked = affinityFor({ brand: "Stride", priceMinor: 200000 }, taste);
    const unknown = affinityFor({ brand: "Aeris", priceMinor: 200000 }, taste);
    const panned = affinityFor({ brand: "Torvi", priceMinor: 200000 }, taste);

    expect(liked.normalized).toBeGreaterThan(unknown.normalized);
    expect(unknown.normalized).toBeGreaterThan(panned.normalized);
    expect(liked.reasons[0]).toContain("Stride");
  });

  it("does not let budget alone dominate the score", () => {
    // Almost every product sits inside a shopper's usual range, so if budget
    // counted as much as brand the criterion would score nearly everything
    // full marks and stop discriminating at all.
    const taste = profile({ budget: { p25Minor: 100000, p75Minor: 500000 } });
    const affordable = affinityFor({ priceMinor: 300000 }, taste);

    expect(affordable.normalized).toBeGreaterThan(0.5);
    expect(affordable.normalized).toBeLessThan(0.8);
  });

  it("never penalises something cheaper than the shopper usually pays", () => {
    const taste = profile({ budget: { p25Minor: 300000, p75Minor: 800000 } });

    const cheap = affinityFor({ priceMinor: 50000 }, taste);
    const dear = affinityFor({ priceMinor: 2400000 }, taste);

    expect(cheap.normalized).toBeGreaterThan(0.5);
    expect(dear.normalized).toBeLessThan(cheap.normalized);
  });

  it("carries a quality preference into a category the shopper has never bought", () => {
    // This is the case a profile is actually for: "likes breathable things"
    // should help with a first request in an unfamiliar category.
    const taste = profile({ qualities: { breathability: 1, comfort: 0.5 } });

    const breathable = affinityFor(
      { category: "Bedding", priceMinor: 200000, qualities: { breathability: 5, comfort: 4 } },
      taste,
    );
    const stifling = affinityFor(
      { category: "Bedding", priceMinor: 200000, qualities: { breathability: 1, comfort: 2 } },
      taste,
    );

    expect(breathable.normalized).toBeGreaterThan(stifling.normalized);
    expect(breathable.reasons.join(" ")).toContain("breathability");
  });

  it("does not let one purchase count three times through brand, merchant and colour", () => {
    // Brand, merchant and colour all matching is usually the same past order
    // restated. Averaging keeps that from outscoring a genuinely broader match.
    const narrow = profile({
      brands: { stride: 1 },
      merchants: { "stride athletics": 1 },
      colours: { black: 1 },
    });

    const triple = affinityFor(
      { brand: "Stride", merchantName: "Stride Athletics", colour: "Black", priceMinor: 200000 },
      narrow,
    );

    expect(triple.normalized).toBeLessThanOrEqual(1);
    // A single strong brand match on its own reaches the same ceiling — the
    // extra two axes restate it rather than compounding it.
    const single = affinityFor({ brand: "Stride", priceMinor: 200000 }, narrow);
    expect(triple.normalized).toBeCloseTo(single.normalized, 5);
  });

  it("stays within 0..1 so contributions remain comparable with other criteria", () => {
    const taste = profile({
      brands: { stride: 1 },
      categories: { "running shoes": 1 },
      qualities: { comfort: 1 },
      budget: { p25Minor: 100000, p75Minor: 200000 },
    });

    for (const price of [1000, 200000, 99_000_000]) {
      const { normalized } = affinityFor(
        { brand: "Stride", category: "Running Shoes", priceMinor: price, qualities: { comfort: 5 } },
        taste,
      );
      expect(normalized).toBeGreaterThanOrEqual(0);
      expect(normalized).toBeLessThanOrEqual(1);
    }
  });

  it("treats an empty profile as no profile at all", () => {
    expect(hasTaste(EMPTY_TASTE)).toBe(false);
    expect(affinityFor({ brand: "Stride", priceMinor: 100 }, EMPTY_TASTE).normalized).toBe(0.5);
    expect(hasTaste(profile({ brands: { stride: 1 } }))).toBe(true);
  });
});
