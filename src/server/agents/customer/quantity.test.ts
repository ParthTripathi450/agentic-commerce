import { describe, expect, it } from "vitest";
import { getVocabulary } from "@/server/catalog/vocabulary";
import { hasVaguePlural, parseIntentWithRules } from "./intent-rules";

/**
 * The agent must not answer a question the shopper did not ask.
 *
 * "A few pairs" means more than one. Silently returning a single item is a
 * guess presented as an answer, which is the failure mode this guards.
 */
describe("quantity ambiguity", () => {
  it("spots vague plurals that carry no number", () => {
    for (const phrase of [
      "a few pairs of running shoes",
      "some yoga mats",
      "several notebooks",
      "running shoes for my team",
      "power banks in bulk",
    ]) {
      expect(hasVaguePlural(phrase), phrase).toBe(true);
    }
  });

  it("treats an explicit number as settled", () => {
    for (const phrase of ["2 pairs of running shoes", "three yoga mats", "5 notebooks"]) {
      expect(hasVaguePlural(phrase), phrase).toBe(false);
    }
  });

  it("leaves an ordinary singular request alone", () => {
    for (const phrase of ["a yoga mat", "black running shoes size 10", "noise cancelling headphones"]) {
      expect(hasVaguePlural(phrase), phrase).toBe(false);
    }
  });

  it("asks how many rather than assuming one", async () => {
    const vocabulary = await getVocabulary();
    const vague = parseIntentWithRules("I need a few yoga mats", vocabulary);
    expect(vague.clarificationNeeded).toMatch(/how many/i);
    expect(vague.quantityStated).toBe(false);
  });

  it("does not interrogate a plain single-item request", async () => {
    const vocabulary = await getVocabulary();
    const plain = parseIntentWithRules("a yoga mat under 2000", vocabulary);
    expect(plain.clarificationNeeded).toBeNull();
    expect(plain.quantity).toBe(1);
  });

  it("records that a stated quantity was actually stated", async () => {
    const vocabulary = await getVocabulary();
    const stated = parseIntentWithRules("2 pairs of running shoes", vocabulary);
    expect(stated.quantity).toBe(2);
    expect(stated.quantityStated).toBe(true);
  });
});

describe("category is a fact, not a guess", () => {
  it("only filters by category when the shopper named one", async () => {
    const { getVocabulary } = await import("@/server/catalog/vocabulary");
    const vocabulary = await getVocabulary();

    // "running shoes" IS a category name, so filtering on it is grounded.
    expect(parseIntentWithRules("black running shoes size 10", vocabulary).category).toBe(
      "Running Shoes",
    );

    // "yoga mat" is not a category (mats live in Fitness Accessories). Inferring
    // one here removed every yoga mat and surfaced t-shirts instead.
    expect(parseIntentWithRules("a yoga mat under 2000", vocabulary).category).toBeNull();
    expect(parseIntentWithRules("noise cancelling headphones", vocabulary).category).toBeNull();
  });
});
