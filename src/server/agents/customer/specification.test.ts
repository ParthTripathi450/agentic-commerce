import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { runShoppingTurn } from "./agent";

/**
 * A shopper's own words have to reach the search.
 *
 * The scripted questions cover purpose, size, colour and budget, which is what
 * most shoppers need — but not the one who cares about a material, a weight
 * limit or a feature nobody put in a slot. Enumerating those is §8.21's trap;
 * asking plainly and understanding the answer is not.
 */
async function demoShopper() {
  const [row] = (await db.execute(sql`
    SELECT id FROM users WHERE email = 'demo@shopper.test'
  `)) as unknown as { id: string }[];
  return row.id;
}

describe("a free-form specification changes what is searched", () => {
  it("turns 'it must be waterproof' into a constraint, not just words", async () => {
    const userId = await demoShopper();

    const plain = await runShoppingTurn({
      userId,
      message: "I want running shoes for road running",
      skipQuestions: true,
      limit: 4,
    });
    const specified = await runShoppingTurn({
      userId,
      message: "I want running shoes for road running. It must be waterproof.",
      skipQuestions: true,
      limit: 4,
    });

    // The model extracts the constraint from language; SQL applies it. Without
    // the predicate this would be a phrase that flavours similarity and
    // nothing more, which is how "waterproof" used to return shoes rated 1/5.
    const constraints = specified.intent.qualityConstraints ?? [];
    expect(constraints.length).toBeGreaterThan(0);
    expect(constraints.some((c) => /water/i.test(c.key))).toBe(true);

    const waterOf = (turn: typeof plain) =>
      turn.ranking.ranked.map(
        (r) =>
          ((r.candidate.attributes as { qualities?: Record<string, number> })?.qualities
            ?.waterResistance ?? 0),
      );

    const specifiedScores = waterOf(specified);
    expect(specifiedScores.length).toBeGreaterThan(0);
    for (const score of specifiedScores) expect(score).toBeGreaterThanOrEqual(4);

    // And it genuinely changed the outcome rather than coinciding with it.
    expect(Math.min(...specifiedScores)).toBeGreaterThan(Math.min(...waterOf(plain)));
  });

  it("leaves the search alone when the shopper adds nothing", async () => {
    const userId = await demoShopper();
    const turn = await runShoppingTurn({
      userId,
      message: "I want running shoes for road running. Nothing else.",
      skipQuestions: true,
      limit: 3,
    });

    // "Nothing else" must not become a constraint or a search term.
    expect(turn.ranking.ranked.length).toBeGreaterThan(0);
    expect(turn.intent.productQuery.toLowerCase()).not.toContain("nothing else");
  });
});

describe("the chosen focus reaches the autonomous run", () => {
  it("weights the feature the shopper picked", async () => {
    // The autonomous route took a single synthesised sentence and nothing
    // else, so answering "comfort" to the prioritise question was dropped
    // before anything was ranked — asking was theatre.
    const userId = await demoShopper();

    const focused = await runShoppingTurn({
      userId,
      message: "running shoes for road running",
      skipQuestions: true,
      limit: 5,
      focusQuality: "comfort",
    });

    const criterion = focused.ranking.ranked[0]?.criteria.find((c) =>
      c.name.toLowerCase().includes("comfort"),
    );
    expect(criterion).toBeDefined();
    expect(criterion!.weight).toBeGreaterThan(0);
  });
});
