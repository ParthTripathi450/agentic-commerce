import { describe, expect, it } from "vitest";
import { intentFromUnderstanding, type ConversationUnderstanding } from "./conversation";

/**
 * Conversational understanding → intent.
 *
 * The property that matters: an unstated slot must reach the search as NULL,
 * never as a guess. A fabricated filter is worse than a broad search, because
 * it silently removes products the shopper would have wanted.
 */

const understanding = (
  over: Partial<ConversationUnderstanding> = {},
): ConversationUnderstanding => ({
  slots: {
    productType: null, purpose: null, size: null, color: null, brand: null,
    width: null, gender: null, budgetMax: null, budgetMin: null, quantity: null,
    ...(over.slots ?? {}),
  },
  understanding: "",
  readyToSearch: true,
  question: null,
  questionAbout: null,
  suggestions: [],
  searchPhrase: "running shoes",
  priority: "balanced",
  degraded: false,
  meta: {},
  ...over,
});

describe("intentFromUnderstanding", () => {
  it("leaves unstated slots null rather than inventing them", () => {
    const intent = intentFromUnderstanding(understanding(), "i want shoes");
    expect(intent.attributes).toEqual({});
    expect(intent.priceMaxMinor).toBeNull();
    expect(intent.priceMinMinor).toBeNull();
    expect(intent.brand).toBeNull();
    expect(intent.quantityStated).toBe(false);
  });

  it("turns stated slots into filters", () => {
    const intent = intentFromUnderstanding(
      understanding({
        slots: {
          productType: "shoes", purpose: "road running", size: "9", color: "Black",
          brand: "Arcus", width: "wide", gender: null,
          budgetMax: 8000, budgetMin: null, quantity: 2,
        },
      }),
      "black arcus running shoes size 9 under 8000, two pairs",
    );
    expect(intent.attributes.size).toBe("9");
    expect(intent.attributes.color).toBe("black");
    expect(intent.attributes.width).toBe("wide");
    expect(intent.brand).toBe("Arcus");
    expect(intent.priceMaxMinor).toBe(800000);
    expect(intent.quantity).toBe(2);
    expect(intent.quantityStated).toBe(true);
  });

  it("NEVER sets category, however confident the model is about purpose", () => {
    // §8.8: a guessed category used as a hard filter buried every yoga mat.
    // Purpose reaches retrieval through the semantic phrase instead.
    const intent = intentFromUnderstanding(
      understanding({ slots: { purpose: "marathon racing" }, searchPhrase: "marathon racing shoes" }),
      "shoes for a marathon",
    );
    expect(intent.category).toBeNull();
    expect(intent.productQuery).toContain("marathon");
  });

  it("keeps requireInStock true unless the shopper asked otherwise", () => {
    expect(intentFromUnderstanding(understanding(), "i want shoes").requireInStock).toBe(true);
    expect(
      intentFromUnderstanding(understanding(), "show me shoes including out of stock")
        .requireInStock,
    ).toBe(false);
  });

  it("carries the priority the model understood", () => {
    const intent = intentFromUnderstanding(
      understanding({ priority: "cheapest" }),
      "the cheapest shoes you have",
    );
    expect(intent.priority).toBe("cheapest");
  });

  it("falls back to the shopper's own words when no search phrase came back", () => {
    const intent = intentFromUnderstanding(
      understanding({ searchPhrase: "", slots: { productType: null } }),
      "something for the gym",
    );
    expect(intent.productQuery).toBe("something for the gym");
  });

  it("treats quantity 0 as unstated, not as zero items", () => {
    const intent = intentFromUnderstanding(
      understanding({ slots: { quantity: 0 } }),
      "a few pairs of shoes",
    );
    expect(intent.quantity).toBe(1);
    expect(intent.quantityStated).toBe(false);
  });
});
