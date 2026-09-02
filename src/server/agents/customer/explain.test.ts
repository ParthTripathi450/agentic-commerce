import { describe, expect, it } from "vitest";
import { hybridSearch } from "@/server/catalog/search";
import { explainSelection } from "./explain";
import { intentToQuery, parseIntent } from "./intent";
import { rankCandidates } from "./ranker";

describe("UNDERSTAND → SEARCH → RANK → EXPLAIN", () => {
  it("explains the reference query using only real scoring facts", async () => {
    const { intent } = await parseIntent("Find me black running shoes, size 10, under ₹5,000");
    const search = await hybridSearch(intentToQuery(intent));
    const ranking = rankCandidates(search.candidates, {
      priority: intent.priority,
      budgetMinor: intent.priceMaxMinor,
      rejected: search.rejected,
      limit: 5,
    });
    const explanation = await explainSelection({
      intent,
      ranked: ranking.ranked,
      weights: ranking.weights,
      excluded: ranking.rejectedAlternatives,
    });

    console.log("\n--- points ---");
    for (const point of explanation.points) console.log("  • " + point);
    console.log("\n--- ranking ---");
    for (const r of ranking.ranked) {
      console.log(
        `  #${r.rank} ${r.score.toFixed(3)}  ₹${r.candidate.variant.priceMinor / 100}  ` +
          `${r.candidate.title} (${r.candidate.merchant.slug})  stock=${r.candidate.variant.availableQuantity}`,
      );
    }
    console.log("\n--- top factors ---");
    for (const f of explanation.topFactors) {
      console.log(`  ${f.name}: weight ${f.weight} × ${f.normalized} = ${f.contribution}`);
    }
    console.log("\n--- excluded ---");
    for (const e of explanation.excluded.slice(0, 6)) console.log(`  ${e.label} → ${e.reason}`);

    expect(explanation.points.length).toBeGreaterThanOrEqual(3);
    expect(explanation.topFactors).toHaveLength(3);
    // Contributions must be ordered strongest first.
    expect(explanation.topFactors[0].contribution).toBeGreaterThanOrEqual(
      explanation.topFactors[1].contribution,
    );

    // Points must be short enough to scan.
    for (const point of explanation.points) {
      expect(point.length).toBeLessThan(120);
    }

    // The first point names the product actually chosen.
    expect(explanation.points[0]).toContain(ranking.ranked[0].candidate.title);

    // Internal scoring numbers must never reach the shopper — "0.9957" is
    // meaningless to them and was leaking into the explanation.
    for (const point of explanation.points) {
      expect(point, `leaked an internal score: ${point}`).not.toMatch(/\b0\.\d{3,}\b/);
    }
  });

  it("gives a concrete reason for every runner-up", async () => {
    const { intent } = await parseIntent("black running shoes size 10 under 5000");
    const search = await hybridSearch(intentToQuery(intent));
    const ranking = rankCandidates(search.candidates, {
      budgetMinor: intent.priceMaxMinor,
      rejected: search.rejected,
      limit: 5,
    });
    const explanation = await explainSelection({
      intent,
      ranked: ranking.ranked,
      weights: ranking.weights,
      excluded: ranking.rejectedAlternatives,
    });

    expect(explanation.comparisons.length).toBeGreaterThan(0);
    for (const c of explanation.comparisons) {
      expect(c.summary).toMatch(/Scored/);
      expect(c.deltas.length).toBeGreaterThan(0);
    }
  });
});
