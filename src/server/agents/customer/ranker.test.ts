import { describe, expect, it } from "vitest";
import { hybridSearch, type StructuredQuery } from "@/server/catalog/search";
import {
  compareToWinner,
  confidenceAdjustedRatingBp,
  rankCandidates,
  WEIGHT_PRESETS,
} from "./ranker";

const QUERY: StructuredQuery = {
  text: "black running shoes for daily road training",
  attributes: { color: "black", size: "10" },
  priceMaxMinor: 500000,
  requireInStock: true,
};

describe("ranking weights", () => {
  it("every preset sums to 1.0", () => {
    for (const [name, weights] of Object.entries(WEIGHT_PRESETS)) {
      const total = Object.values(weights).reduce((a, b) => a + b, 0);
      expect(total, `preset ${name}`).toBeCloseTo(1, 6);
    }
  });
});

describe("rankCandidates", () => {
  it("scores are the sum of their criterion contributions", async () => {
    const { candidates, rejected } = await hybridSearch(QUERY);
    const { ranked } = rankCandidates(candidates, { budgetMinor: 500000, rejected });

    expect(ranked.length).toBeGreaterThan(1);
    for (const item of ranked) {
      const sum = item.criteria.reduce((s, c) => s + c.contribution, 0);
      expect(sum).toBeCloseTo(item.score, 3);
      // Each contribution must be weight × normalized — no hidden adjustments.
      for (const c of item.criteria) {
        expect(c.contribution).toBeCloseTo(c.weight * c.normalized, 3);
      }
    }
  });

  it("is deterministic across repeated runs", async () => {
    const { candidates } = await hybridSearch(QUERY);
    const a = rankCandidates(candidates, { budgetMinor: 500000 });
    const b = rankCandidates(candidates, { budgetMinor: 500000 });
    expect(a.ranked.map((r) => r.candidate.productId)).toEqual(
      b.ranked.map((r) => r.candidate.productId),
    );
    expect(a.ranked[0].score).toBe(b.ranked[0].score);
  });

  it("a stated priority visibly changes the winner", async () => {
    const { candidates } = await hybridSearch(QUERY);
    const cheapest = rankCandidates(candidates, { priority: "cheapest", budgetMinor: 500000 });
    const flexible = rankCandidates(candidates, { priority: "most_flexible", budgetMinor: 500000 });

    const cheapestPrice = cheapest.ranked[0].candidate.variant.priceMinor;
    const allPrices = candidates.map((c) => c.variant.priceMinor);
    expect(cheapestPrice).toBe(Math.min(...allPrices));

    // Prioritising returns should favour the longest return window available.
    const bestReturns = Math.max(...candidates.map((c) => c.policies.returnWindowDays));
    expect(flexible.ranked[0].candidate.policies.returnWindowDays).toBe(bestReturns);
  });

  it("carries forward the reason each filtered product was excluded", async () => {
    const { candidates, rejected } = await hybridSearch(QUERY);
    const { rejectedAlternatives } = rankCandidates(candidates, { rejected });
    expect(rejectedAlternatives.length).toBeGreaterThan(0);
    expect(rejectedAlternatives.every((r) => r.reason.length > 0)).toBe(true);
  });

  it("states factual differences against the runner-up", async () => {
    const { candidates } = await hybridSearch(QUERY);
    const { ranked } = rankCandidates(candidates, { budgetMinor: 500000 });
    const comparison = compareToWinner(ranked[0], ranked[1]);

    expect(comparison.summary).toContain("Scored");
    const priceGap =
      ranked[1].candidate.variant.priceMinor - ranked[0].candidate.variant.priceMinor;
    if (priceGap > 0) {
      expect(comparison.deltas.some((d) => d.includes("more expensive"))).toBe(true);
    }
  });
});

describe("customer ratings", () => {
  it("weights ratings as a major signal in the default mix", () => {
    expect(WEIGHT_PRESETS.balanced.rating).toBeGreaterThanOrEqual(0.2);
    // Prioritising quality should weight ratings above everything else.
    const quality = WEIGHT_PRESETS.best_quality;
    const heaviest = Object.entries(quality).sort(([, a], [, b]) => b - a)[0][0];
    expect(heaviest).toBe("rating");
  });

  it("does not let a tiny sample of perfect scores outrank a well-reviewed product", () => {
    const prior = 4200;
    // 5.0 from 3 reviews vs 4.6 from 900 reviews.
    const sparsePerfect = confidenceAdjustedRatingBp(5000, 3, prior);
    const provenGood = confidenceAdjustedRatingBp(4600, 900, prior);

    expect(sparsePerfect).toBeLessThan(provenGood);
    // The sparse rating is pulled most of the way back to the average.
    expect(sparsePerfect).toBeLessThan(4300);
    // A heavily-reviewed rating is trusted almost at face value.
    expect(provenGood).toBeGreaterThan(4570);
  });

  it("treats an unrated product as average rather than worst", () => {
    const prior = 4200;
    expect(confidenceAdjustedRatingBp(null, 0, prior)).toBe(prior);
    expect(confidenceAdjustedRatingBp(4800, 0, prior)).toBe(prior);
  });

  it("reports the real rating while scoring the adjusted one", async () => {
    const { candidates } = await hybridSearch(QUERY);
    const { ranked } = rankCandidates(candidates, { budgetMinor: 500000 });

    for (const item of ranked) {
      const rating = item.criteria.find((c) => c.name === "rating")!;
      // Shown value is what the customer actually sees on the product.
      expect(rating.value).toBe(item.candidate.ratingBp ?? 0);
      expect(rating.note).toBeTruthy();
    }
  });
});
