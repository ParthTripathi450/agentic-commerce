import { createHash } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { evidenceChunks } from "@/db/schema";
import { embed } from "@/server/ai/embeddings";

/**
 * Embeds reviews as individually retrievable chunks.
 *
 * Kept out of `catalog_documents` on purpose. That table answers "which
 * product?" with one vector per product; averaging forty opinions into it would
 * blur the product's own identity and match neither the specs nor the reviews
 * well. Here each review is its own vector, so "do these run hot in summer?"
 * can retrieve the sentence that answers it and cite the review it came from.
 *
 * Incremental on a content hash, like the catalogue indexer — re-running is
 * cheap and only re-embeds what actually changed.
 */

const EMBED_BATCH = 32;

export type EvidenceIndexResult = {
  total: number;
  indexed: number;
  skipped: number;
  pruned: number;
  durationMs: number;
};

function chunkHash(body: string, ratingBp: number): string {
  return createHash("sha256").update(`${ratingBp}|${body}`).digest("hex");
}

/**
 * The chunk is the OPINION, and nothing else.
 *
 * This used to prefix every chunk with "Review of <product> (<category>) — <n>
 * out of 5", on the reasoning that a bare body has no idea what it is about. It
 * is the wrong trade and §8.23 already says why: shared phrasing across
 * documents compresses the embedding space. On a two-line review that boilerplate
 * is half the tokens, so the vector ends up encoding the template that every
 * chunk shares instead of the sentence that distinguishes it.
 *
 * It failed exactly as you would expect. "My feet get unbearably hot on long
 * runs" retrieved THERMAL RUNNING TIGHTS as its best match at 0.643 — a garment
 * whose entire purpose is to make you warm — because "Running", "Activewear"
 * and a star rating dominated the comparison and the actual complaint did not.
 *
 * Grounding is not needed here anyway: `productId`, `merchantId` and `ratingBp`
 * are COLUMNS on this table. They can be filtered, joined and displayed without
 * being embedded, which is the reason the evidence lives in its own table
 * rather than folded into the product document.
 */
function chunkText(input: { title: string | null; body: string | null }): string {
  return [input.title ?? "", input.body ?? ""].filter(Boolean).join(". ").trim();
}

export async function indexEvidence(options?: {
  productIds?: string[];
  force?: boolean;
  onProgress?: (done: number, total: number) => void;
}): Promise<EvidenceIndexResult> {
  const startedAt = Date.now();

  const rows = (await db.execute(sql`
    SELECT r.id, r.product_id, r.merchant_id, r.rating_bp, r.title, r.body,
           p.title AS product_title, p.category
    FROM product_reviews r
    JOIN products p ON p.id = r.product_id
    WHERE p.status = 'active'
      AND coalesce(r.body, '') <> ''
      ${options?.productIds?.length ? sql`AND r.product_id IN ${options.productIds}` : sql``}
    ORDER BY r.created_at
  `)) as unknown as {
    id: string; product_id: string; merchant_id: string; rating_bp: number;
    title: string | null; body: string | null; product_title: string; category: string;
  }[];

  const total = rows.length;
  if (total === 0) return { total: 0, indexed: 0, skipped: 0, pruned: 0, durationMs: 0 };

  const existing = await db
    .select({ sourceId: evidenceChunks.sourceId, sourceHash: evidenceChunks.sourceHash })
    .from(evidenceChunks)
    .where(eq(evidenceChunks.kind, "review"));
  const hashBySource = new Map(existing.map((e) => [e.sourceId, e.sourceHash]));

  const prepared = rows.map((row) => {
    const body = chunkText({ title: row.title, body: row.body });
    return {
      sourceId: row.id,
      productId: row.product_id,
      merchantId: row.merchant_id,
      ratingBp: Number(row.rating_bp),
      body,
      hash: chunkHash(body, Number(row.rating_bp)),
    };
  });

  const pending = prepared.filter(
    (entry) => options?.force || hashBySource.get(entry.sourceId) !== entry.hash,
  );
  const skipped = total - pending.length;
  let done = 0;

  for (let i = 0; i < pending.length; i += EMBED_BATCH) {
    const batch = pending.slice(i, i + EMBED_BATCH);
    const vectors = await embed(batch.map((b) => b.body));

    // No unique constraint on source_id, so replace rather than upsert.
    await db.delete(evidenceChunks).where(
      inArray(evidenceChunks.sourceId, batch.map((b) => b.sourceId)),
    );

    await db.insert(evidenceChunks).values(
      batch.map((entry, idx) => ({
        productId: entry.productId,
        merchantId: entry.merchantId,
        kind: "review" as const,
        sourceId: entry.sourceId,
        body: entry.body,
        ratingBp: entry.ratingBp,
        embedding: vectors[idx],
        sourceHash: entry.hash,
        embeddedAt: new Date(),
      })),
    );

    done += batch.length;
    options?.onProgress?.(done, pending.length);
  }

  // Chunks whose review was deleted would otherwise be retrievable forever.
  const pruned = await db.execute(sql`
    DELETE FROM evidence_chunks
    WHERE kind = 'review'
      AND (source_id IS NULL OR source_id NOT IN (SELECT id FROM product_reviews))
  `);

  return {
    total,
    indexed: pending.length,
    skipped,
    pruned: (pruned as unknown as { count?: number }).count ?? 0,
    durationMs: Date.now() - startedAt,
  };
}
