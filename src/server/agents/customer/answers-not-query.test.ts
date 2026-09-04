import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { runShoppingTurn } from "./agent";
import { toTurnDto } from "./dto";
import { stripRequestFiller } from "./clarify";
import { parseIntentWithRules } from "./intent-rules";
import { getVocabulary } from "@/server/catalog/vocabulary";
import { RELEVANCE_WEIGHT, WEIGHT_PRESETS } from "./ranker";

/**
 * Asking for formal shoes returned Budget Running Shoes and Laceless Sneakers.
 *
 * Three independent defects, each of which alone was enough to cause it, and
 * all three only visible on the DEGRADED path — which is a normal path on a
 * free tier (§8.13), not an edge case.
 */
describe("answers are constraints, never search terms", () => {
  it("keeps the query to what was asked for, however many questions follow", async () => {
    const [user] = (await db.execute(sql`
      SELECT id FROM users WHERE email = 'demo@shopper.test'
    `)) as unknown as { id: string }[];

    const history: { role: "shopper" | "agent"; content: string }[] = [];
    const answered: string[] = [];
    let searched = "";

    for (const message of ["looking for some formal shoes", "9", "black", "no budget limit"]) {
      const turn = await runShoppingTurn({
        userId: user.id,
        message,
        history: [...history],
        answered: answered as never[],
        limit: 3,
      });
      const dto = toTurnDto(turn);
      history.push({ role: "shopper", content: message });
      searched = dto.intent.productQuery;
      if (dto.question) {
        answered.push(dto.question.id);
        history.push({ role: "agent", content: dto.question.question });
      }
    }

    // The query used to accumulate into
    // "looking for some formal shoes, 9, black, no budget limit", where
    // "formal" is one term among several and the rest is noise.
    expect(searched).not.toMatch(/\b9\b/);
    expect(searched.toLowerCase()).not.toContain("black");
    expect(searched.toLowerCase()).not.toContain("budget");
    expect(searched.toLowerCase()).toContain("formal");
  });

  it("strips the request preamble without losing the product", () => {
    expect(stripRequestFiller("looking for some formal shoes")).toBe("formal shoes");
    expect(stripRequestFiller("I want a new pair of running shoes")).toContain("running shoes");
    // Nothing but filler leaves the text alone rather than returning nothing.
    expect(stripRequestFiller("i want some")).toBeTruthy();
  });
});

describe("'no budget limit' is not a request for the cheapest thing", () => {
  it("reads the negation rather than the word 'budget'", async () => {
    const vocab = await getVocabulary();
    for (const phrase of [
      "no budget limit",
      "not worried about budget",
      "looking for some formal shoes, 9, black, no budget limit",
    ]) {
      expect(parseIntentWithRules(phrase, vocab).priority, phrase).toBe("balanced");
    }
  });

  it("still hears a genuine request for the cheapest", async () => {
    const vocab = await getVocabulary();
    for (const phrase of ["cheapest formal shoes", "budget running shoes", "the cheapest one"]) {
      expect(parseIntentWithRules(phrase, vocab).priority, phrase).toBe("cheapest");
    }
  });
});

describe("no preset may trade away relevance", () => {
  it("gives relevance the same share in every preset", () => {
    // `cheapest` dropped it to 0.12 and pushed price to 0.58, so a product
    // called "Budget Running Shoes" scored 0.021 on relevance and lost almost
    // nothing for it. Choosing "cheapest" means the cheapest OF THE RIGHT THING.
    for (const [name, weights] of Object.entries(WEIGHT_PRESETS)) {
      expect(weights.relevance, name).toBe(RELEVANCE_WEIGHT);
    }
  });

  it("still sums to one", () => {
    for (const [name, weights] of Object.entries(WEIGHT_PRESETS)) {
      const total = Object.values(weights).reduce((sum, w) => sum + (w ?? 0), 0);
      expect(total, name).toBeCloseTo(1, 6);
    }
  });

  it("keeps price dominant for cheapest, without letting it outvote the product", () => {
    expect(WEIGHT_PRESETS.cheapest.price).toBeGreaterThan(WEIGHT_PRESETS.balanced.price);
    expect(WEIGHT_PRESETS.cheapest.price).toBeGreaterThan(WEIGHT_PRESETS.cheapest.relevance);
  });
});
