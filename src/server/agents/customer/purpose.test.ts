import { describe, expect, it } from "vitest";
import { NEUTRAL_PURPOSE, purposeMatch, purposeTextOf } from "./purpose";

/**
 * What a product says it is FOR, as a tie-breaker.
 *
 * The gap this closes: a leather sneaker and a leather dress shoe are genuinely
 * close in both embedding and keyword space, so relevance cannot separate them —
 * but the catalogue is not ambiguous at all. One says `use: "formal"`, the other
 * says `useCase: "everyday wear and casual court style"`.
 */

const dressShoe = { use: "formal", features: ["budget", "interview", "padded footbed"] };
const courtSneaker = { useCase: "everyday wear and casual court style", style: "low top" };
const courtShoe = { useCase: "tennis, badminton and indoor court sports" };
const silent = { material: "nylon", features: ["reflective trim", "packs into pocket"] };

describe("purposeMatch", () => {
  it("separates a dress shoe from a casual sneaker on an office request", () => {
    const query = "formal shoes for the office";
    expect(purposeMatch(query, dressShoe).normalized).toBeGreaterThan(
      purposeMatch(query, courtSneaker).normalized,
    );
  });

  it("recognises a product listed for the sport that was asked for", () => {
    const { normalized, matched } = purposeMatch("shoes I can play tennis in", courtShoe);
    expect(normalized).toBeGreaterThan(NEUTRAL_PURPOSE);
    expect(matched).toContain("tennis");
  });

  it("treats silence as neutral, never as a mismatch", () => {
    // A third of the catalogue publishes no purpose text. The Windshell
    // Packable Running Jacket has none and is a correct answer for "a warm
    // winter jacket" — penalising absence is a data-completeness bias dressed
    // up as relevance.
    expect(purposeMatch("a warm winter jacket", silent).normalized).toBe(NEUTRAL_PURPOSE);
    expect(purposeMatch("anything", {}).normalized).toBe(NEUTRAL_PURPOSE);
    expect(purposeMatch("anything", null).normalized).toBe(NEUTRAL_PURPOSE);
  });

  it("scores a stated but unrelated purpose below neutral, and above zero", () => {
    // Evidence of a mismatch, not disqualification: it is still a shoe and may
    // still be worth showing on its other merits.
    const score = purposeMatch("formal shoes for the office", courtSneaker).normalized;
    expect(score).toBeLessThan(NEUTRAL_PURPOSE);
    expect(score).toBeGreaterThan(0);
  });

  it("cannot be gamed by a long marketing sentence", () => {
    // Scored on the share of the QUERY's words accounted for, so padding the
    // purpose text with more words cannot raise the score.
    const terse = { use: "formal" };
    const padded = {
      useCase:
        "formal occasions and also weddings and parties and travel and commuting and leisure",
    };
    const query = "formal shoes for the office";
    expect(purposeMatch(query, padded).normalized).toBeLessThanOrEqual(
      purposeMatch(query, terse).normalized,
    );
  });

  it("stays inside 0..1 so it stays comparable with every other criterion", () => {
    for (const attrs of [dressShoe, courtSneaker, courtShoe, silent, {}]) {
      const { normalized } = purposeMatch("formal shoes for the office tennis warm", attrs);
      expect(normalized).toBeGreaterThanOrEqual(0);
      expect(normalized).toBeLessThanOrEqual(1);
    }
  });

  it("ignores filler so a chatty request is not diluted", () => {
    const direct = purposeMatch("formal", dressShoe).normalized;
    const chatty = purposeMatch("I am really looking for something formal", dressShoe).normalized;
    expect(chatty).toBeGreaterThan(NEUTRAL_PURPOSE);
    expect(direct).toBeGreaterThan(NEUTRAL_PURPOSE);
  });
});

describe("purposeTextOf", () => {
  it("gathers every field a merchant uses to say what a thing is for", () => {
    const text = purposeTextOf(dressShoe);
    expect(text).toContain("formal");
    expect(text).toContain("interview");
  });

  it("returns nothing when the merchant said nothing", () => {
    expect(purposeTextOf({ material: "leather" })).toBe("");
    expect(purposeTextOf(null)).toBe("");
  });
});
