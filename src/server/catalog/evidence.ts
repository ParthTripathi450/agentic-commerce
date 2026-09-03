import { sql } from "drizzle-orm";
import { db } from "@/db";
import { embedOne } from "@/server/ai/embeddings";

/**
 * Retrieval over what BUYERS said, as opposed to what the catalogue says.
 *
 * `catalog_documents` answers "which product?" — one vector each, built from the
 * seller's own copy. This answers "what do we actually KNOW about it?", one
 * vector per review sentence. The distinction is the whole reason the two are
 * separate tables: averaging forty opinions into a product's document would
 * blur its identity and match neither its spec sheet nor the opinions well.
 *
 * It exists because the numbers cannot answer the questions people ask. A shoe
 * carrying `breathability: 4` tells a shopper nothing; a buyer writing "no
 * swampy feeling even on long days" answers the question they actually had. And
 * the same corpus is what makes an agent trustworthy in the other direction —
 * `durability: 1` is a shrug, "starting to show wear after a couple of months"
 * is a warning worth heeding.
 *
 * **Nothing here generates text.** It returns real sentences with the review
 * they came from, so anything said downstream can be traced to a person who
 * wrote it. That is the property that makes this retrieval rather than
 * plausible invention.
 */

export type EvidenceChunk = {
  chunkId: string;
  productId: string;
  productTitle: string;
  body: string;
  ratingBp: number | null;
  /** Cosine similarity to the question, 0..1. */
  score: number;
};

/**
 * How close a review sentence must be before it counts as evidence.
 *
 * Same discipline as the catalogue's relevance gate, for the same reason: a
 * model handed the nearest three sentences will summarise them however
 * irrelevant they are, so "nothing close enough" has to be a result the
 * retrieval layer can return. Measured against this corpus — on-topic sentences
 * land 0.45–0.75, and unrelated ones sit below 0.30.
 */
export const MIN_EVIDENCE_SCORE = 0.34;

/** At most this many sentences from any one product, so one does not fill the page. */
const PER_PRODUCT_CAP = 3;

export type EvidenceQuery = {
  question: string;
  /** Restrict to these products. Omit to search the whole corpus. */
  productIds?: string[];
  limit?: number;
  /**
   * Require the product to be buyable. On a product page the shopper is already
   * looking at the thing, so its reviews are relevant whatever its stock; in the
   * agent's path an answer about something nobody can buy is a wasted turn.
   */
  requireBuyable?: boolean;
  /** Override the relevance floor. Only `evidenceByTopic` needs this. */
  minScore?: number;
};

export async function retrieveEvidence(query: EvidenceQuery): Promise<EvidenceChunk[]> {
  const question = query.question.trim();
  if (!question) return [];
  if (query.productIds?.length === 0) return [];

  const limit = query.limit ?? 6;
  const vector = JSON.stringify(await embedOne(question));

  const scopeFilter = query.productIds?.length
    ? sql`AND ec.product_id IN (${sql.join(query.productIds.map((id) => sql`${id}`), sql`, `)})`
    : sql``;

  const buyableFilter = query.requireBuyable
    ? sql`AND EXISTS (
          SELECT 1 FROM product_variants v
          JOIN inventory i ON i.variant_id = v.id
          WHERE v.product_id = ec.product_id AND v.active
            AND GREATEST(i.quantity - i.reserved, 0) > 0
        )`
    : sql``;

  // Over-fetched deliberately: the cap and the near-duplicate filter below both
  // discard rows, so asking for exactly `limit` would routinely return fewer.
  const rows = (await db.execute(sql`
    SELECT ec.id, ec.product_id, ec.body, ec.rating_bp,
           p.title AS product_title,
           1 - (ec.embedding <=> ${vector}::vector) AS score
    FROM evidence_chunks ec
    JOIN products p ON p.id = ec.product_id
    WHERE ec.embedding IS NOT NULL
      AND p.status = 'active'
      ${scopeFilter}
      ${buyableFilter}
    ORDER BY ec.embedding <=> ${vector}::vector
    LIMIT ${limit * 6}
  `)) as unknown as Record<string, unknown>[];

  const chunks = rows
    .map((r) => ({
      chunkId: String(r.id),
      productId: String(r.product_id),
      productTitle: String(r.product_title),
      body: String(r.body),
      ratingBp: r.rating_bp != null ? Number(r.rating_bp) : null,
      score: Number(r.score),
    }))
    .filter((c) => c.score >= (query.minScore ?? MIN_EVIDENCE_SCORE));

  return trim(chunks, limit);
}

/**
 * Caps per product and drops near-duplicate sentences.
 *
 * Reviews of the same product repeat each other heavily — three buyers of the
 * Vantor Kestrel all wrote almost exactly "plenty of airflow, no swampy
 * feeling". Quoting the same sentence three times reads as the agent padding,
 * and worse, it makes one opinion look like a consensus. Comparing on a
 * normalised prefix catches those without needing another embedding pass.
 */
function trim(chunks: EvidenceChunk[], limit: number): EvidenceChunk[] {
  // The cap exists to stop one chatty product filling a cross-catalogue result.
  // Scoped to a single product it would throw away most of the evidence, so it
  // only applies when more than one product is in play.
  const capped = new Set(chunks.map((c) => c.productId)).size > 1;
  const perProduct = new Map<string, number>();
  const seen = new Set<string>();
  const out: EvidenceChunk[] = [];

  for (const chunk of chunks) {
    const used = perProduct.get(chunk.productId) ?? 0;
    if (capped && used >= PER_PRODUCT_CAP) continue;

    const fingerprint = chunk.body.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 60);
    if (seen.has(fingerprint)) continue;

    seen.add(fingerprint);
    perProduct.set(chunk.productId, used + 1);
    out.push(chunk);
    if (out.length >= limit) break;
  }

  return out;
}

/**
 * The products whose reviews best answer a question, most convincing first.
 *
 * This is retrieval BY evidence rather than by description, and it reaches
 * queries the catalogue text cannot. "My feet get unbearably hot" shares no
 * vocabulary with a spec sheet, but it is almost word-for-word how a reviewer
 * would put it — so searching what buyers wrote aims at the phrasing the
 * question actually uses.
 *
 * Scored by the best chunk per product, not the sum: a product with forty
 * mediocre mentions should not outrank one with a single sentence that answers
 * the question exactly.
 */
export async function productsByEvidence(
  question: string,
  limit = 10,
): Promise<{ productId: string; score: number; best: EvidenceChunk }[]> {
  const chunks = await retrieveEvidence({
    question,
    limit: limit * 4,
    requireBuyable: true,
  });

  const best = new Map<string, EvidenceChunk>();
  for (const chunk of chunks) {
    const current = best.get(chunk.productId);
    if (!current || chunk.score > current.score) best.set(chunk.productId, chunk);
  }

  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((chunk) => ({ productId: chunk.productId, score: chunk.score, best: chunk }));
}

/**
 * Groups a product's own reviews under the question each one actually answers.
 *
 * The product page knows which qualities its category is rated on, so it can
 * ask the corpus a real question per quality ("do they get hot and sweaty?")
 * rather than printing a bar labelled 4/5. Both are shown: the number is the
 * summary, the sentence is the evidence behind it.
 *
 * **Each chunk is assigned to its single best topic, not each topic to its best
 * chunk.** Taking the nearest chunk per topic independently put the SAME
 * sentence under comfort, support, durability and breathability — within one
 * product every review is written in the same register about the same object,
 * so they all score similarly against every question and the argmax is the only
 * thing that separates them. A page quoting one sentence four times under four
 * headings is worse than one that stays quiet.
 */
export async function evidenceByTopic(
  productId: string,
  topics: string[],
  perTopic = 2,
): Promise<{ topic: string; chunks: EvidenceChunk[] }[]> {
  if (topics.length === 0) return [];

  const scored = await Promise.all(
    topics.map(async (topic) => ({
      topic,
      // No floor yet: a chunk has to be scored against every topic before its
      // best one is known, and filtering here would hide the comparison.
      chunks: await retrieveEvidence({
        question: questionFor(topic),
        productIds: [productId],
        limit: 40,
        minScore: 0,
      }),
    })),
  );

  const bestTopic = new Map<string, { topic: string; chunk: EvidenceChunk }>();
  for (const { topic, chunks } of scored) {
    for (const chunk of chunks) {
      const current = bestTopic.get(chunk.chunkId);
      if (!current || chunk.score > current.chunk.score) bestTopic.set(chunk.chunkId, { topic, chunk });
    }
  }

  const grouped = new Map<string, EvidenceChunk[]>();
  for (const { topic, chunk } of bestTopic.values()) {
    if (chunk.score < MIN_EVIDENCE_SCORE) continue;
    const bucket = grouped.get(topic) ?? [];
    bucket.push(chunk);
    grouped.set(topic, bucket);
  }

  return topics
    .map((topic) => ({
      topic,
      chunks: (grouped.get(topic) ?? []).sort((a, b) => b.score - a.score).slice(0, perTopic),
    }))
    .filter((r) => r.chunks.length > 0);
}

/**
 * Turns a quality key into the question a shopper would actually ask.
 *
 * The embedding is matching against review PROSE, so the query should read like
 * prose. "breathability" is a column name; "do they get hot and sweaty?" is what
 * someone wrote a review about, and it retrieves markedly better for it.
 */
function questionFor(quality: string): string {
  const phrasings: Record<string, string> = {
    breathability: "do they get hot and sweaty, is there enough airflow",
    durability: "how well does it hold up over time, does it wear out",
    comfort: "is it comfortable to wear for a long time",
    grip: "does it slip, how is the traction",
    waterResistance: "does it keep water out in the rain",
    support: "does it support my feet and ankles",
    stability: "does it feel stable and secure",
    materialQuality: "how good is the material and the build quality",
    easeOfCare: "is it easy to wash and look after",
    packability: "does it pack down small and light",
    portability: "is it easy to carry around",
    warmth: "does it keep me warm",
    fit: "how does it fit, is the sizing right",
  };

  return phrasings[quality] ?? quality.replace(/([A-Z])/g, " $1").toLowerCase().trim();
}
