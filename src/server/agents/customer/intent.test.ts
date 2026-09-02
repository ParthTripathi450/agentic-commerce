import { describe, expect, it } from "vitest";
import { providerStatus } from "@/server/ai/llm";
import { getVocabulary } from "@/server/catalog/vocabulary";
import { parseIntent } from "./intent";
import { parseIntentWithRules } from "./intent-rules";

/**
 * These exercise the no-API-key path: with no provider configured the router
 * falls back to rules, so the platform must still parse a real request.
 */

describe("rule-based intent parsing", () => {
  it("parses the reference query end to end", async () => {
    const vocabulary = await getVocabulary();
    const intent = parseIntentWithRules(
      "Find me black running shoes, size 10, under ₹5,000",
      vocabulary,
    );

    expect(intent.attributes.color).toBe("black");
    expect(intent.attributes.size).toBe("10");
    expect(intent.priceMaxMinor).toBe(500000);
    expect(intent.category).toBe("Running Shoes");
    expect(intent.productQuery).toContain("running shoes");
    // Constraint phrasing must not leak into the semantic query.
    expect(intent.productQuery).not.toMatch(/5,000|size 10/);
  });

  it("understands the many ways shoppers write a budget", async () => {
    const vocabulary = await getVocabulary();
    const cases: Array<[string, number]> = [
      ["headphones under 8000", 800000],
      ["headphones below ₹8,000", 800000],
      ["headphones less than rs 8000", 800000],
      ["headphones upto 8k", 800000],
      ["headphones with a budget of INR 8,000", 800000],
    ];
    for (const [text, expected] of cases) {
      expect(parseIntentWithRules(text, vocabulary).priceMaxMinor, text).toBe(expected);
    }
  });

  it("detects a minimum price separately from a maximum", async () => {
    const vocabulary = await getVocabulary();
    const intent = parseIntentWithRules("a backpack above 3000 and under 9000", vocabulary);
    expect(intent.priceMinMinor).toBe(300000);
    expect(intent.priceMaxMinor).toBe(900000);
  });

  it("maps emphasis onto a ranking priority", async () => {
    const vocabulary = await getVocabulary();
    expect(parseIntentWithRules("cheapest yoga mat", vocabulary).priority).toBe("cheapest");
    expect(parseIntentWithRules("need a power bank by tomorrow", vocabulary).priority).toBe("fastest");
    expect(parseIntentWithRules("best rated earbuds", vocabulary).priority).toBe("best_quality");
    expect(parseIntentWithRules("earbuds I can return easily", vocabulary).priority).toBe("most_flexible");
  });

  it("never invents a vocabulary value the catalog lacks", async () => {
    const vocabulary = await getVocabulary();
    const intent = parseIntentWithRules("chartreuse running shoes in size 47", vocabulary);
    expect(intent.attributes.color).toBeUndefined();
    expect(intent.attributes.size).toBeUndefined();
  });

  it("reads quantities written as digits or words", async () => {
    const vocabulary = await getVocabulary();
    expect(parseIntentWithRules("2 pairs of running shoes", vocabulary).quantity).toBe(2);
    expect(parseIntentWithRules("three units of the power bank", vocabulary).quantity).toBe(3);
    expect(parseIntentWithRules("a yoga mat", vocabulary).quantity).toBe(1);
  });
});

describe("parseIntent (router)", () => {
  it("parses the reference query correctly whether or not an LLM is configured", async () => {
    const { intent, degraded } = await parseIntent(
      "Find me black running shoes, size 10, under ₹5,000",
    );
    // Same guarantees in both modes: degraded quality, never degraded function.
    expect(intent.attributes).toEqual({ color: "black", size: "10" });
    expect(intent.priceMaxMinor).toBe(500000);
    expect(intent.requireInStock).toBe(true);

    // With no provider configured the fallback is the ONLY path.
    // With one configured it may still degrade — a free tier can rate-limit at
    // any moment — and that is the designed behaviour, not a failure.
    if (!providerStatus().usable) expect(degraded).toBe(true);
  });

  it.runIf(providerStatus().usable)(
    "treats a budget ceiling as a constraint, not a 'cheapest' priority",
    async () => {
      // Regression: the model previously read "under ₹5,000" as "prioritise
      // price", which demoted a better-supported shoe in favour of the cheapest.
      const { intent } = await parseIntent("Find me black running shoes, size 10, under ₹5,000");
      expect(intent.priceMaxMinor).toBe(500000);
      expect(intent.priority).toBe("balanced");

      const explicit = await parseIntent("Find me the cheapest black running shoes in size 10");
      expect(explicit.intent.priority).toBe("cheapest");
    },
  );
});
