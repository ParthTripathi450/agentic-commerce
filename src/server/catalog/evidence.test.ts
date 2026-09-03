import { describe, expect, it } from "vitest";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import {
  MIN_EVIDENCE_SCORE,
  evidenceByTopic,
  productsByEvidence,
  retrieveEvidence,
} from "./evidence";

/**
 * Retrieval over reviews, and the discipline that keeps it honest.
 *
 * The whole value of this layer is that everything it returns was written by a
 * person. Nothing is generated, so the properties worth testing are that it
 * finds the right sentences, refuses when there are none, and never quotes the
 * same one twice.
 */
describe("retrieveEvidence", () => {
  it("finds reviews that answer a question phrased nothing like the catalogue", async () => {
    const hits = await retrieveEvidence({ question: "will it keep the rain off me" });

    expect(hits.length).toBeGreaterThan(0);
    // The point of the layer: the shopper's wording, not the spec sheet's.
    expect(hits.map((h) => h.body).join(" ").toLowerCase()).toMatch(/rain|water|dry|wet/);
  });

  it("returns nothing rather than the nearest thing when nothing is close", async () => {
    // Same discipline as the catalogue relevance gate: a model handed the
    // nearest three sentences will summarise them however irrelevant they are,
    // so "nothing close enough" has to be a result this layer can return.
    const hits = await retrieveEvidence({ question: "quantum blockchain tax litigation" });
    expect(hits).toEqual([]);
  });

  it("keeps every result above the relevance floor", async () => {
    const hits = await retrieveEvidence({ question: "is it comfortable" });
    for (const hit of hits) expect(hit.score).toBeGreaterThanOrEqual(MIN_EVIDENCE_SCORE);
  });

  it("never quotes the same sentence twice", async () => {
    // Reviews of one product repeat each other heavily. Quoting a sentence
    // three times reads as padding, and makes one opinion look like consensus.
    const hits = await retrieveEvidence({ question: "how is the grip", limit: 8 });
    const fingerprints = hits.map((h) => h.body.toLowerCase().slice(0, 60));
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it("scopes to the products it was given", async () => {
    const [row] = (await db.execute(sql`
      SELECT product_id FROM evidence_chunks LIMIT 1
    `)) as unknown as { product_id: string }[];

    const hits = await retrieveEvidence({
      question: "is it any good",
      productIds: [row.product_id],
      minScore: 0,
    });
    expect(hits.every((h) => h.productId === row.product_id)).toBe(true);
  });

  it("returns nothing for an empty scope rather than searching everything", async () => {
    // An empty list means "none of these", and must never widen to the whole
    // corpus — that is how a scoped question silently becomes a global one.
    expect(await retrieveEvidence({ question: "comfortable", productIds: [] })).toEqual([]);
    expect(await retrieveEvidence({ question: "   " })).toEqual([]);
  });
});

describe("productsByEvidence", () => {
  it("ranks products by their single best sentence, not by review count", async () => {
    const hits = await productsByEvidence("no slipping on wet ground", 5);

    expect(hits.length).toBeGreaterThan(0);
    // One product must not appear twice; a product with forty mediocre
    // mentions must not outrank one sentence that answers the question.
    const ids = hits.map((h) => h.productId);
    expect(new Set(ids).size).toBe(ids.length);

    const scores = hits.map((h) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("only surfaces products that can be bought today", async () => {
    const hits = await productsByEvidence("comfortable for long days", 5);
    if (hits.length === 0) return;

    const rows = (await db.execute(sql`
      SELECT COUNT(DISTINCT p.id) AS n FROM products p
      JOIN product_variants v ON v.product_id = p.id
      JOIN inventory i ON i.variant_id = v.id
      WHERE p.id IN (${sql.join(hits.map((h) => sql`${h.productId}`), sql`, `)})
        AND v.active AND GREATEST(i.quantity - i.reserved, 0) > 0
    `)) as unknown as { n: string }[];

    expect(Number(rows[0].n)).toBe(hits.length);
  });
});

describe("evidenceByTopic", () => {
  it("puts each sentence under one topic rather than repeating it under all", async () => {
    // Within a single product every review is written in the same register
    // about the same object, so they score similarly against every question.
    // Taking the nearest chunk per topic independently put the SAME sentence
    // under four headings.
    const [row] = (await db.execute(sql`
      SELECT p.id, p.attributes->'qualities' AS q
      FROM products p JOIN evidence_chunks ec ON ec.product_id = p.id
      WHERE p.attributes ? 'qualities'
      GROUP BY p.id HAVING COUNT(*) >= 6 LIMIT 1
    `)) as unknown as { id: string; q: Record<string, number> }[];

    const grouped = await evidenceByTopic(row.id, Object.keys(row.q));
    const quoted = grouped.flatMap((g) => g.chunks.map((c) => c.chunkId));

    expect(new Set(quoted).size).toBe(quoted.length);
  });

  it("returns no topics at all when asked for none", async () => {
    expect(await evidenceByTopic("whatever", [])).toEqual([]);
  });
});
