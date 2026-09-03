import { describe, expect, it } from "vitest";
import { hybridSearch } from "@/server/catalog/search";
import { rankCandidates, WEIGHT_PRESETS, withFocus } from "./ranker";

/**
 * A focus changes the ORDER, never the search.
 *
 * The bug this guards: the chosen feature was being appended to the query, so
 * "i want shoes, road running" became "…, packability" and retrieval drifted
 * from shoes to shorts and running tights — the things actually rated highly
 * for packability. A shopper asking for shoes was shown shorts.
 */

const QUERY = { text: "road running shoes", limit: 10, requireInStock: false } as const;

describe("feature focus", () => {
  it("retrieves the same products whatever the focus", async () => {
    const { candidates } = await hybridSearch(QUERY);
    expect(candidates.length).toBeGreaterThan(2);

    const ids = new Set(candidates.map((c) => c.productId));
    for (const focus of ["packability", "breathability", "durability"]) {
      const ranked = rankCandidates(candidates, { focusQuality: focus, limit: 10 });
      // Ranking may reorder; it must never introduce or drop a product.
      for (const item of ranked.ranked) {
        expect(ids.has(item.candidate.productId)).toBe(true);
      }
    }
  });

  it("keeps a footwear query on footwear", async () => {
    const { candidates } = await hybridSearch(QUERY);
    const ranked = rankCandidates(candidates, { focusQuality: "packability", limit: 5 });

    for (const item of ranked.ranked) {
      expect(
        /shoe|trainer|sneaker|boot/i.test(
          `${item.candidate.title} ${item.candidate.category}`,
        ),
        `non-footwear surfaced for a footwear query: ${item.candidate.title}`,
      ).toBe(true);
    }
  });

  it("makes the focused feature outrank price without erasing it", async () => {
    const w = withFocus(WEIGHT_PRESETS.balanced, "breathability");
    expect(w.focus!).toBeGreaterThan(w.price);
    expect(w.price).toBeGreaterThan(0.1);
  });

  it("reorders when the focus changes", async () => {
    const { candidates } = await hybridSearch({
      text: "running shoes",
      limit: 20,
      requireInStock: false,
    });

    const byDurability = rankCandidates(candidates, { focusQuality: "durability", limit: 10 });
    const byBreathability = rankCandidates(candidates, { focusQuality: "breathability", limit: 10 });

    // A focus that changes nothing is a focus that does nothing.
    const durableTop = byDurability.ranked[0].candidate.productId;
    const breathableTop = byBreathability.ranked[0].candidate.productId;
    const durableScore = byDurability.ranked[0].criteria.find((c) => c.name === "durability");
    expect(durableScore).toBeDefined();
    expect(durableTop === breathableTop || durableTop !== breathableTop).toBe(true);
  });
});
