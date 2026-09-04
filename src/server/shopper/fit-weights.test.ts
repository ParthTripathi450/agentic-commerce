import { describe, expect, it } from "vitest";
import { DEFAULT_AXES } from "@/server/agents/customer/affinity";
import { evaluateForYou, prepareCases } from "./for-you-eval";
import { fitAxisWeights } from "./fit-weights";

/**
 * The fitter has to be honest before its numbers are useful.
 *
 * A weight search will always find something that scores better on the data it
 * searched; the only question worth asking is whether the gain survives on
 * shoppers it never saw.
 */
describe("fitAxisWeights", () => {
  it("reports a held-out score, not just a training one", async () => {
    const result = await fitAxisWeights({ folds: 3 });

    expect(result.shoppers).toBeGreaterThan(0);
    expect(result.folds).toBe(3);
    // Both numbers are reported precisely so the gap between them is visible.
    expect(result.baseline.test).toBeGreaterThanOrEqual(0);
    expect(result.fitted.test).toBeGreaterThanOrEqual(0);
  });

  it("never scores worse than the hand-picked weights on the training data", async () => {
    // Coordinate descent starts FROM the defaults and only moves on an
    // improvement, so a fitted set that trains worse would mean the search is
    // broken rather than the weights being bad.
    const result = await fitAxisWeights({ folds: 3 });
    expect(result.fitted.train).toBeGreaterThanOrEqual(result.baseline.train - 1e-9);
  });

  it("keeps every axis inside the searched range", async () => {
    const result = await fitAxisWeights({ folds: 3 });
    for (const value of Object.values(result.axes)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1.3);
    }
  });
});

describe("axis weights actually change the ranking", () => {
  it("scores differently when an axis is turned off", async () => {
    // If they did not, the fitter would be searching a flat surface and its
    // agreement with the defaults would mean nothing.
    const prepared = await prepareCases();
    const withBrand = await evaluateForYou({ preloaded: prepared, axes: DEFAULT_AXES });
    const withoutBrand = await evaluateForYou({
      preloaded: prepared,
      axes: { ...DEFAULT_AXES, brand: 0, category: 0 },
    });

    expect(withoutBrand.affinity.mrr).not.toBe(withBrand.affinity.mrr);
  });

  it("leaves the shipped defaults untouched", async () => {
    // The fitter reports; a person decides. Generated orders mean a fitted set
    // encodes the seed's habits, so nothing may be applied automatically.
    await fitAxisWeights({ folds: 3 });
    expect(DEFAULT_AXES.quality).toBe(1);
    expect(DEFAULT_AXES.brand).toBe(1);
  });
});
