import { describe, expect, it } from "vitest";
import { composeTitle, dedupeTags } from "./product-assistant";
import { buildVariantCombos, MAX_VARIANTS } from "./variants";

/**
 * Listing-assistant invariants.
 *
 * These cover the two things that actually went wrong in use: a title that
 * repeated the brand, and an unbounded cartesian product of variant options.
 */

describe("composeTitle", () => {
  it("does not repeat a brand the product name already carries", () => {
    // The bug as it appeared in the catalogue: "Nike Nike Air Zoom Pegasus".
    expect(composeTitle("Nike", "Nike Air Zoom Pegasus")).toBe("Nike Air Zoom Pegasus");
    expect(composeTitle("Adidas", "Adidas Ultraboost Light")).toBe("Adidas Ultraboost Light");
  });

  it("prefixes the brand when the name omits it", () => {
    expect(composeTitle("Adidas", "Ultraboost Light")).toBe("Adidas Ultraboost Light");
    expect(composeTitle("Stride", "Velocity Run 3")).toBe("Stride Velocity Run 3");
  });

  it("matches the brand on a word boundary, not a substring", () => {
    // "Peak" must not be considered present inside "Peakless".
    expect(composeTitle("Peak", "Peakless Trail Shoe")).toBe("Peak Peakless Trail Shoe");
  });

  it("is case-insensitive about the brand already being there", () => {
    expect(composeTitle("Nike", "nike air max")).toBe("nike air max");
  });

  it("survives an empty brand or product name", () => {
    expect(composeTitle("", "Ultraboost")).toBe("Ultraboost");
    expect(composeTitle("Adidas", "")).toBe("Adidas");
  });
});

describe("buildVariantCombos", () => {
  it("produces the cartesian product of the kept options", () => {
    const result = buildVariantCombos({ size: ["S", "M"], color: ["black", "navy"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.combos).toHaveLength(4);
    expect(result.combos).toContainEqual({ size: "S", color: "black" });
    expect(result.combos).toContainEqual({ size: "M", color: "navy" });
  });

  it("yields one variant when the product has no options", () => {
    const result = buildVariantCombos({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.combos).toEqual([{}]);
  });

  it("ignores an axis with nothing selected rather than producing zero variants", () => {
    const result = buildVariantCombos({ size: ["S", "M"], color: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.combos).toHaveLength(2);
  });

  it("refuses an explosion instead of silently creating dozens of SKUs", () => {
    // 10 sizes x 5 colours = 50, which is what the wizard actually offers for
    // a shoe. Creating those unasked is tedious to undo by hand.
    const result = buildVariantCombos({
      size: ["5", "6", "7", "8", "9", "10", "11", "12", "13", "14"],
      color: ["white", "black", "grey", "blue", "red"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.count).toBe(50);
    expect(result.count).toBeGreaterThan(MAX_VARIANTS);
  });

  it("accepts exactly the cap", () => {
    const result = buildVariantCombos({
      size: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"],
      color: ["black", "white"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.combos).toHaveLength(MAX_VARIANTS);
  });
});

describe("dedupeTags", () => {
  it("normalises case and whitespace and drops duplicates", () => {
    expect(dedupeTags(["Road Running", "road  running", "CUSHIONED"])).toEqual([
      "road running",
      "cushioned",
    ]);
  });

  it("drops values too short or too long to be useful search terms", () => {
    expect(dedupeTags(["a", "ok", "x".repeat(80)])).toEqual(["ok"]);
  });

  it("caps the list so tags cannot dilute their own weighting", () => {
    expect(dedupeTags(Array.from({ length: 30 }, (_, i) => `tag ${i}`))).toHaveLength(14);
  });
});
