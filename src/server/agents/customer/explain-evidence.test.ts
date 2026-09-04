import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { hybridSearch } from "@/server/catalog/search";
import { explainSelection } from "./explain";
import { intentToQuery } from "./intent";
import { shoppingIntentSchema } from "./intent-schema";
import { rankCandidates } from "./ranker";

/**
 * The agent's explanation now carries what buyers said about its pick.
 *
 * The property that makes this safe is that the model never touches the review
 * text: quotes are retrieved by code and rendered verbatim. A paraphrase of a
 * review is a new claim attributed to a real person who did not make it, which
 * is a worse failure than a clumsy score narration.
 */
async function explainFor(query: string) {
  const intent = shoppingIntentSchema.parse({ productQuery: query, requireInStock: true });
  const search = await hybridSearch(intentToQuery(intent));
  const ranking = rankCandidates(search.candidates, {
    priority: "balanced",
    limit: 3,
    queryText: query,
  });
  const explanation = await explainSelection({
    intent,
    ranked: ranking.ranked,
    weights: ranking.weights,
    excluded: ranking.rejectedAlternatives,
  });
  return { explanation, winner: ranking.ranked[0] };
}

/**
 * Whether a given pick has quotable reviews depends on which product wins and
 * how its reviewers happened to write, so a single query is not a reliable way
 * to exercise this. These run a spread and assert over whatever comes back.
 */
const QUERIES = [
  "shoes I can play tennis in",
  "a comfortable hoodie for cold mornings",
  "running shoes with good grip on wet ground",
  "a jacket that keeps the rain out",
];

describe("explanations carry buyer evidence", () => {
  it("fires at all — some pick comes back with its buyers quoted", async () => {
    const results = await Promise.all(QUERIES.map((q) => explainFor(q)));
    const withEvidence = results.filter((r) => r.explanation.evidence.length > 0);
    expect(withEvidence.length).toBeGreaterThan(0);
  });

  it("only ever quotes reviews of the product it actually chose", async () => {
    // A quote about a different product would read as evidence for this one,
    // which is worse than no quote at all.
    for (const query of QUERIES) {
      const { explanation, winner } = await explainFor(query);
      for (const chunk of explanation.evidence) {
        expect(chunk.productId).toBe(winner.candidate.productId);
      }
    }
  });

  it("quotes verbatim — every sentence exists in the corpus unchanged", async () => {
    // The strongest available check that nothing was rewritten: each quoted
    // body must match a stored chunk exactly, byte for byte.
    let checked = 0;
    for (const query of QUERIES) {
      const { explanation } = await explainFor(query);
      for (const chunk of explanation.evidence) {
        const rows = (await db.execute(sql`
          SELECT COUNT(*) AS n FROM evidence_chunks
          WHERE id = ${chunk.chunkId} AND body = ${chunk.body}
        `)) as unknown as { n: string }[];
        expect(Number(rows[0].n)).toBe(1);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("keeps the reasons free of decimals, as before", async () => {
    // The pre-existing guarantee must survive: the model still sees only
    // computed criteria, so no internal score can leak into the prose.
    const { explanation } = await explainFor("a comfortable hoodie for cold mornings");
    for (const point of explanation.points) {
      expect(point).not.toMatch(/0\.\d{3,}/);
    }
  });

  it("explains fine when the catalogue has nothing to quote", async () => {
    // Evidence is an improvement to an explanation, never a precondition for
    // one — a product with no reviews must still get its reasons.
    const [row] = (await db.execute(sql`
      SELECT p.id, p.title FROM products p
      WHERE p.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM evidence_chunks ec WHERE ec.product_id = p.id)
      LIMIT 1
    `)) as unknown as { id: string; title: string }[];
    if (!row) return;

    const { explanation } = await explainFor(row.title);
    expect(explanation.points.length).toBeGreaterThan(0);
  });
});
