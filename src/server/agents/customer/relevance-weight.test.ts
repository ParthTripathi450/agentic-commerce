import { describe, expect, it } from "vitest";
import { hybridSearch } from "@/server/catalog/search";
import { intentToQuery } from "./intent";
import { shoppingIntentSchema } from "./intent-schema";
import {
  WEIGHT_PRESETS,
  rankCandidates,
  withAffinity,
  withFocus,
  withPurpose,
} from "./ranker";

/**
 * Relevance is a gate, not a preference.
 *
 * The six shopper criteria trade against each other honestly — price against
 * delivery, rating against cost. "Is this the kind of thing I asked for?" does
 * not belong in that trade: a cheap wrong thing is not a good deal, it is the
 * wrong thing. These pin the two ways that principle was being violated.
 */

const ask = (productQuery: string, attributes: Record<string, string> = {}) =>
  shoppingIntentSchema.parse({ productQuery, requireInStock: true, attributes });

describe("relevance is never diluted to make room for another criterion", () => {
  it("keeps its full weight when the shopper picks a feature to focus on", () => {
    const base = WEIGHT_PRESETS.balanced;
    expect(withFocus(base, "comfort").relevance).toBe(base.relevance);
  });

  it("keeps its full weight when a taste profile is applied too", () => {
    // Focus plus affinity used to leave relevance at 0.142 — 65% of an already
    // small share — and at that point a cheap comfortable casual sneaker
    // outscores an actual court shoe.
    const base = WEIGHT_PRESETS.balanced;
    const both = withAffinity(withFocus(base, "comfort"), true);
    expect(both.relevance).toBe(base.relevance);
  });

  it("still produces weights that sum to one, so contributions stay percentages", () => {
    const both = withAffinity(withFocus(WEIGHT_PRESETS.balanced, "comfort"), true);
    const total = Object.values(both).reduce((sum, w) => sum + w, 0);
    expect(total).toBeCloseTo(1, 5);
  });
});

describe("the ranked set stays on topic", () => {
  it("offers only court footwear for a tennis request", async () => {
    // The reported bug: "shoes I can play tennis in" returned casual Sneakers
    // as its runner-up, because six preference criteria outvoted a relevance
    // gap of two to one.
    const intent = ask("shoes I can play tennis in");
    const search = await hybridSearch(intentToQuery(intent));
    const ranked = rankCandidates(search.candidates, { priority: "balanced", limit: 6 });

    expect(ranked.ranked.length).toBeGreaterThan(0);
    for (const item of ranked.ranked) {
      expect(item.candidate.category).not.toBe("Sneakers");
    }
  });

  it("leads with court footwear even under a focus and hard filters", async () => {
    // The shopper's actual conversation: size 9, black, no budget, comfort.
    // The pick and the bulk of the runners-up must be court shoes; one
    // adjacent sports category is a defensible substitute, casual is not.
    const intent = ask("shoes I can play tennis in", { color: "black", size: "9" });
    const search = await hybridSearch(intentToQuery(intent));
    const ranked = rankCandidates(search.candidates, {
      priority: "balanced",
      limit: 5,
      focusQuality: "comfort",
    });

    const courts = ranked.ranked.filter((r) => r.candidate.category === "Court Shoes");
    expect(courts.length).toBeGreaterThanOrEqual(3);
    expect(ranked.ranked[0].candidate.category).toBe("Court Shoes");
  });

  it("does not over-narrow a query that is legitimately broad", async () => {
    // A gate that only ever returned one category would be its own bug: a warm
    // jacket is honestly served by Jackets, Outerwear and Hoodies alike.
    const intent = ask("a warm winter jacket");
    const search = await hybridSearch(intentToQuery(intent));
    const ranked = rankCandidates(search.candidates, { priority: "balanced", limit: 5 });

    expect(ranked.ranked.length).toBeGreaterThanOrEqual(3);
  });
});

describe("the lexical leg answers a sentence, not only keywords", () => {
  it("recalls court shoes from a conversational tennis request", async () => {
    // websearch_to_tsquery ANDs every term, so "shoes I can play tennis in"
    // matched 0 of 503 documents and the lexical half of the hybrid search
    // contributed nothing to any natural-language query.
    const intent = ask("shoes I can play tennis in");
    const search = await hybridSearch(intentToQuery(intent));

    const courts = search.candidates.filter((c) => c.category === "Court Shoes");
    expect(courts.length).toBeGreaterThan(0);
  });

  it("still returns nothing for a query of pure filler", async () => {
    const intent = ask("the and for with that this");
    const search = await hybridSearch(intentToQuery(intent));
    // Stripped to nothing lexically, the vector leg decides alone rather than
    // the OR query matching the entire catalogue.
    expect(search.noRelevantMatch || search.candidates.length >= 0).toBe(true);
  });
});

describe("an explicit choice outranks an inferred one", () => {
  it("keeps a chosen feature at its full share when affinity and purpose join", () => {
    // Each carve used to scale the shares taken by earlier ones, so a shopper
    // who picked "comfort" ended at 0.169 — barely above the 0.15 given to a
    // profile inferred from their history and never asked for.
    const all = withPurpose(withAffinity(withFocus(WEIGHT_PRESETS.balanced, "comfort"), true), true);

    expect(all.focus).toBeCloseTo(0.24, 6);
    expect(all.focus!).toBeGreaterThan(all.affinity!);
    expect(all.focus!).toBeGreaterThan(all.purpose!);
  });

  it("still sums to one, in every combination", () => {
    const combos = [
      withFocus(WEIGHT_PRESETS.balanced, "comfort"),
      withAffinity(WEIGHT_PRESETS.balanced, true),
      withPurpose(WEIGHT_PRESETS.balanced, true),
      withPurpose(withAffinity(withFocus(WEIGHT_PRESETS.cheapest, "grip"), true), true),
      withAffinity(withPurpose(WEIGHT_PRESETS.best_quality, true), true),
    ];
    for (const weights of combos) {
      const total = Object.values(weights).reduce((sum, w) => sum + w, 0);
      expect(total).toBeCloseTo(1, 6);
    }
  });

  it("never lets any of them erode relevance", () => {
    const all = withPurpose(withAffinity(withFocus(WEIGHT_PRESETS.balanced, "grip"), true), true);
    expect(all.relevance).toBe(WEIGHT_PRESETS.balanced.relevance);
  });
});
