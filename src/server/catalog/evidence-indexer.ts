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
 * Reviews carry their product's identity into the chunk text.
 *
 * A bare review body ("my feet cooked in July") has no idea what it is about,
 * so a semantic search for "breathable running shoes" would never reach it.
 * Prefixing the product and category grounds the chunk without diluting it the
 * way folding it into the product document would.
 */
function chunkText(input: {
  productTitle: string;
  category: string;
  ratingBp: number;
  title: string | null;
  body: string | null;
}): string {
  const stars = (input.ratingBp / 1000).toFixed(1);
  return [
    `Review of ${input.productTitle} (${input.category}) — ${stars} out of 5.`,
    input.title ?? "",
    input.body ?? "",
  ]
    .filter(Boolean)
    .join(" ");
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
    const body = chunkText({
      productTitle: row.product_title,
      category: row.category,
      ratingBp: Number(row.rating_bp),
      title: row.title,
      body: row.body,
    });
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
