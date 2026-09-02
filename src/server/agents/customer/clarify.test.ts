import { describe, expect, it } from "vitest";
import { shoppingIntentSchema, type ShoppingIntent } from "./intent-schema";
import {
  applyAnswer,
  isFootwear,
  isTooBroad,
  MAX_QUESTIONS,
  missingSlots,
  nextQuestion,
} from "./clarify";

/**
 * Conversational slot-filling.
 *
 * The property under test throughout: the agent ASKS rather than guesses. A
 * missing slot must never become an invented filter.
 */

const intent = (over: Partial<ShoppingIntent> = {}): ShoppingIntent =>
  shoppingIntentSchema.parse({ productQuery: "shoes", ...over });

describe("isTooBroad", () => {
  it("treats the shopper's own example as too broad", () => {
    expect(isTooBroad(intent({ productQuery: "shoes" }))).toBe(true);
    expect(isTooBroad(intent({ productQuery: "I want shoes" }))).toBe(true);
    expect(isTooBroad(intent({ productQuery: "i need some shoes" }))).toBe(true);
  });

  it("does not interrogate an already-specific request", () => {
    expect(
      isTooBroad(
        intent({
          productQuery: "black carbon plate marathon racing shoes",
          category: "Running Shoes",
          attributes: { size: "10" },
        }),
      ),
    ).toBe(false);
  });

  it("counts a stated purpose as specificity even on a short query", () => {
    expect(isTooBroad(intent({ productQuery: "running shoes", priceMaxMinor: 800000 }))).toBe(false);
  });

  it("still asks about a bare 'shoes' even when brand or budget is known", () => {
    // Neither tells you racing vs formal, which is the question that matters.
    expect(isTooBroad(intent({ productQuery: "shoes", brand: "Arcus" }))).toBe(true);
    expect(isTooBroad(intent({ productQuery: "shoes", priceMaxMinor: 300000 }))).toBe(true);
  });
});

describe("isFootwear", () => {
  it("recognises footwear from the category or the wording", () => {
    expect(isFootwear("Formal Shoes", "anything")).toBe(true);
    expect(isFootwear(null, "I need cleats for football")).toBe(true);
    expect(isFootwear(null, "a yoga mat")).toBe(false);
  });
});

describe("missingSlots", () => {
  it("asks purpose first for a bare shoe request", () => {
    const slots = missingSlots(intent({ productQuery: "shoes" }));
    expect(slots[0].id).toBe("purpose");
    // Purpose is the one thing it will not proceed without.
    expect(slots[0].skippable).toBe(false);
  });

  it("does not ask purpose once the shopper has stated one", () => {
    const slots = missingSlots(intent({ productQuery: "marathon running shoes" }));
    expect(slots.map((s) => s.id)).not.toContain("purpose");
  });

  it("does not re-ask for something already known", () => {
    const slots = missingSlots(
      intent({
        productQuery: "black running shoes",
        category: "Running Shoes",
        attributes: { size: "10", color: "black" },
        priceMaxMinor: 800000,
      }),
    );
    expect(slots).toHaveLength(0);
  });

  it("offers real catalogue purposes, not invented ones", () => {
    const purpose = missingSlots(intent({ productQuery: "shoes" }))[0];
    const labels = purpose.options.map((o) => o.label);
    expect(labels).toContain("Marathon / racing");
    expect(labels).toContain("Formal / office");
    expect(labels).toContain("Football");
  });

  it("marks colour and budget skippable so silence never becomes a filter", () => {
    const slots = missingSlots(intent({ productQuery: "running shoes" }));
    for (const id of ["color", "budget"] as const) {
      expect(slots.find((s) => s.id === id)?.skippable).toBe(true);
    }
  });
});

describe("nextQuestion", () => {
  it("asks purpose for a bare request", () => {
    const d = nextQuestion(intent({ productQuery: "shoes" }), []);
    expect(d.ask).toBe(true);
    if (d.ask) expect(d.slot.id).toBe("purpose");
  });

  it("never asks the same slot twice", () => {
    const i = intent({ productQuery: "shoes" });
    const first = nextQuestion(i, []);
    expect(first.ask && first.slot.id).toBe("purpose");
    const second = nextQuestion(i, ["purpose"]);
    expect(second.ask && second.slot.id).not.toBe("purpose");
  });

  it("stops after MAX_QUESTIONS rather than interrogating forever", () => {
    const d = nextQuestion(intent({ productQuery: "shoes" }), ["purpose", "size", "color"]);
    expect(d.ask).toBe(false);
    if (!d.ask) expect(d.reason).toBe("enough_asked");
    expect(MAX_QUESTIONS).toBe(3);
  });

  it("searches immediately when the request is already specific", () => {
    const d = nextQuestion(
      intent({
        productQuery: "black marathon racing shoes size 10 under 15000",
        category: "Running Shoes",
        attributes: { size: "10", color: "black" },
        priceMaxMinor: 1500000,
      }),
      [],
    );
    expect(d.ask).toBe(false);
  });
});

describe("applyAnswer", () => {
  it("folds answers back into the shopper's own words for ONE parser to read", () => {
    expect(applyAnswer("shoes", "purpose", "road running shoes")).toBe("shoes, road running shoes");
    expect(applyAnswer("shoes", "size", "10")).toBe("shoes, size 10");
    expect(applyAnswer("shoes", "color", "black")).toBe("shoes, black");
  });

  it("a skipped answer changes nothing — silence is not a constraint", () => {
    expect(applyAnswer("shoes", "color", "")).toBe("shoes");
    expect(applyAnswer("shoes", "budget", "   ")).toBe("shoes");
  });
});
