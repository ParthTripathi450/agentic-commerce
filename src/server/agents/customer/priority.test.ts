import { describe, expect, it } from "vitest";
import {
  CRITERION_LABELS,
  withFocus,
  SHOPPER_CRITERIA,
  WEIGHT_PRESETS,
  orderFromWeights,
  weightsFromOrder,
  type ShopperCriterion,
} from "./ranker";

/**
 * Shopper-controlled ranking priorities.
 *
 * The ranking must stay a weighted score, not collapse into a single sort key,
 * and relevance must stay out of the shopper's hands — it is what keeps results
 * about the thing they asked for.
 */

describe("weightsFromOrder", () => {
  it("always sums to 1", () => {
    const w = weightsFromOrder(["rating", "returns", "price", "delivery", "reliability", "availability"]);
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it("weights the shopper's first choice highest", () => {
    const w = weightsFromOrder(["returns", "price", "rating", "delivery", "reliability", "availability"]);
    for (const key of SHOPPER_CRITERIA) {
      if (key !== "returns") expect(w.returns).toBeGreaterThan(w[key]);
    }
  });

  it("keeps relevance fixed and out of the shopper's control", () => {
    const a = weightsFromOrder(["price", "rating", "delivery", "returns", "reliability", "availability"]);
    const b = weightsFromOrder(["availability", "reliability", "returns", "delivery", "rating", "price"]);
    expect(a.relevance).toBe(b.relevance);
    expect(a.relevance).toBeGreaterThan(0);
  });

  it("never collapses to a single criterion", () => {
    // A winner-takes-all weighting would make the ranking a plain sort and
    // throw away every other signal.
    const w = weightsFromOrder(["price", "rating", "delivery", "returns", "reliability", "availability"]);
    for (const key of SHOPPER_CRITERIA) expect(w[key]).toBeGreaterThan(0);
  });

  it("accepts a partial order and keeps the rest in their default places", () => {
    const w = weightsFromOrder(["returns"]);
    expect(orderFromWeights(w)[0]).toBe("returns");
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it("ignores unknown or duplicated keys rather than throwing", () => {
    const w = weightsFromOrder([
      "price", "price", "nonsense" as ShopperCriterion, "rating",
    ]);
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(orderFromWeights(w)[0]).toBe("price");
  });

  it("round-trips: order → weights → order", () => {
    const order: ShopperCriterion[] = ["delivery", "price", "availability", "rating", "returns", "reliability"];
    expect(orderFromWeights(weightsFromOrder(order))).toEqual(order);
  });
});

describe("presented criteria", () => {
  it("every shopper criterion has a label and a plain-English hint", () => {
    for (const key of SHOPPER_CRITERIA) {
      expect(CRITERION_LABELS[key].label.length).toBeGreaterThan(0);
      expect(CRITERION_LABELS[key].hint.length).toBeGreaterThan(0);
    }
  });

  it("does not offer relevance as something to reorder", () => {
    expect(SHOPPER_CRITERIA).not.toContain("relevance");
  });

  it("describes each preset as an order the shopper can see", () => {
    expect(orderFromWeights(WEIGHT_PRESETS.cheapest)[0]).toBe("price");
    expect(orderFromWeights(WEIGHT_PRESETS.fastest)[0]).toBe("delivery");
    expect(orderFromWeights(WEIGHT_PRESETS.most_flexible)[0]).toBe("returns");
    expect(orderFromWeights(WEIGHT_PRESETS.best_quality)[0]).toBe("rating");
  });
});


describe("withFocus", () => {
  it("still sums to 1, so scores stay comparable across searches", () => {
    // Adding a criterion without renormalising would make a focused search's
    // scores incomparable to an unfocused one, and the displayed percentages
    // stop being percentages of anything.
    const w = withFocus(WEIGHT_PRESETS.balanced, "breathability");
    expect(Object.values(w).reduce((a, b) => a + (b ?? 0), 0)).toBeCloseTo(1, 6);
  });

  it("makes the focused feature the heaviest single criterion", () => {
    const w = withFocus(WEIGHT_PRESETS.balanced, "breathability");
    for (const [key, value] of Object.entries(w)) {
      if (key !== "focus") expect(w.focus!).toBeGreaterThan(value ?? 0);
    }
  });

  it("keeps price meaningful rather than crowding it out", () => {
    // The shopper asked for the feature to matter ALONGSIDE price, not instead
    // of it, so price must keep a real share of the score.
    const w = withFocus(WEIGHT_PRESETS.balanced, "grip");
    expect(w.price).toBeGreaterThan(0.1);
  });

  it("preserves the relative order of everything else", () => {
    const base = WEIGHT_PRESETS.balanced;
    const focused = withFocus(base, "durability");
    expect(focused.rating > focused.reliability).toBe(base.rating > base.reliability);
    expect(focused.reliability > focused.price).toBe(base.reliability > base.price);
  });

  it("is a no-op without a focus, so an unfocused search is untouched", () => {
    expect(withFocus(WEIGHT_PRESETS.balanced, null)).toEqual(WEIGHT_PRESETS.balanced);
    expect(withFocus(WEIGHT_PRESETS.balanced, undefined)).toEqual(WEIGHT_PRESETS.balanced);
  });
});
