import { describe, expect, it } from "vitest";
import { hybridSearch } from "./search";

/**
 * Rated-feature constraints as a hard filter.
 *
 * The reason these are a predicate rather than a similarity signal: a single
 * embedding cannot represent "at least 4 out of 5", and it places "waterproof
 * but NOT breathable" almost exactly where it places "waterproof AND
 * breathable". Measured on the eval set, trade-off queries scored 0.338 against
 * 0.629 for single attributes on the same corpus and embedder — the gap is
 * logic, not semantics.
 */

describe("quality constraints", () => {
  it("returns only products rated at or above the floor", async () => {
    const { candidates } = await hybridSearch({
      text: "waterproof shoes",
      limit: 10,
      requireInStock: false,
      qualityConstraints: [{ key: "waterResistance", op: "gte", value: 4 }],
    });

    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      const score = (c.attributes as { qualities?: Record<string, number> }).qualities
        ?.waterResistance;
      expect(score, `${c.title} has waterResistance ${score}`).toBeGreaterThanOrEqual(4);
    }
  });

  it("handles a trade-off: high on one feature, low on another", async () => {
    const { candidates } = await hybridSearch({
      text: "waterproof jacket",
      limit: 10,
      requireInStock: false,
      qualityConstraints: [
        { key: "waterResistance", op: "gte", value: 4 },
        { key: "breathability", op: "lte", value: 2 },
      ],
    });

    for (const c of candidates) {
      const q = (c.attributes as { qualities?: Record<string, number> }).qualities ?? {};
      expect(q.waterResistance).toBeGreaterThanOrEqual(4);
      expect(q.breathability).toBeLessThanOrEqual(2);
    }
  });

  it("treats a negation as its own constraint, not the positive term", async () => {
    // The failure this guards: "not waterproof" retrieving the MOST waterproof
    // products, because a bi-encoder puts both phrasings in the same place.
    const { candidates } = await hybridSearch({
      text: "shoes that are not waterproof at all",
      limit: 10,
      requireInStock: false,
      qualityConstraints: [{ key: "waterResistance", op: "lte", value: 2 }],
    });

    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      const score = (c.attributes as { qualities?: Record<string, number> }).qualities
        ?.waterResistance;
      expect(score).toBeLessThanOrEqual(2);
    }
  });

  it("excludes products that do not publish the quality at all", async () => {
    /*
     * Deliberate, and it was measured: tolerating NULL let every product that
     * had never been scored for a quality pass the filter — "packability <= 2"
     * matched every garment — and pinned trade-off recall at 0.438. A missing
     * key means the quality does not apply to that product, not that it scores
     * badly.
     */
    const { candidates } = await hybridSearch({
      text: "shoes",
      limit: 20,
      requireInStock: false,
      qualityConstraints: [{ key: "batteryLife", op: "gte", value: 4 }],
    });

    for (const c of candidates) {
      const q = (c.attributes as { qualities?: Record<string, number> }).qualities ?? {};
      expect(q.batteryLife).toBeDefined();
    }
  });

  it("changes nothing when no constraints are given", async () => {
    const plain = await hybridSearch({ text: "running shoes", limit: 10, requireInStock: false });
    const empty = await hybridSearch({
      text: "running shoes",
      limit: 10,
      requireInStock: false,
      qualityConstraints: [],
    });
    expect(empty.candidates.map((c) => c.productId)).toEqual(
      plain.candidates.map((c) => c.productId),
    );
  });

  it("reports WHY a product was filtered out, with the actual score", async () => {
    const { rejected } = await hybridSearch({
      text: "waterproof shoes",
      limit: 10,
      requireInStock: false,
      qualityConstraints: [{ key: "waterResistance", op: "gte", value: 5 }],
    });
    const byQuality = rejected.filter((r) => r.reason === "quality_mismatch");
    if (byQuality.length > 0) {
      expect(byQuality[0].detail).toMatch(/water resistance is \d\/5/i);
    }
  });
});
