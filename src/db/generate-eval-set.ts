import { config as loadEnv } from "dotenv";
import { writeFileSync, mkdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import * as schema from "./schema";
import { QUALITY_LABELS, type QualityKey } from "./catalog-blueprints";

loadEnv({ path: ".env.local", quiet: true });

/**
 * A labelled retrieval eval set, derived from the same ground truth that
 * generated the catalogue.
 *
 * Expected sets are COMPLETE, never sampled. An earlier version capped them at
 * 40 rows, which made the eval measure the wrong thing entirely: 178 products
 * qualify as breathable, so retrieval could return ten genuinely breathable
 * shoes and score zero because none happened to be in an arbitrary 40. A
 * harness that is wrong is worse than none — it sends you optimising against
 * noise.
 *
 * This is the piece that makes every later tuning decision measurable. Without
 * it you cannot tell whether a change to chunking, weighting or the query
 * pipeline helped or hurt — you can only tell whether the demo still looks
 * fine, which is not the same thing.
 *
 * Ground truth is EXACT rather than hand-labelled, because the quality scores
 * that answer each question are the same scores that wrote the products. The
 * expected set for "which shoes are breathable and waterproof?" is computed by
 * querying those scores, not by someone's judgement of the results.
 */

type EvalCase = {
  id: string;
  /** Natural-language question, as a shopper would ask it. */
  query: string;
  /**
   * Constraints the pipeline would extract for this query.
   *
   * Present on `attribute` and `trade-off` cases, which a shopper states
   * explicitly. Deliberately ABSENT on `paraphrase` cases — those describe the
   * same need without naming the feature, so they measure retrieval rather
   * than a filter agreeing with the predicate that defined the ground truth.
   */
  qualityConstraints?: { key: string; op: "gte" | "lte"; value: number }[];
  /** What is being tested, so a failure is diagnosable. */
  kind: "attribute" | "trade-off" | "category" | "comparison" | "negation" | "budget" | "paraphrase";
  /** Product ids that genuinely satisfy the query. */
  expectedProductIds: string[];
  /** Human-readable expectation, for eyeballing a failure. */
  rationale: string;
};

const ATTRIBUTE_QUERIES: Array<{ key: QualityKey; phrasings: string[] }> = [
  { key: "breathability", phrasings: ["breathable shoes that won't make my feet sweat", "something airy for hot weather", "shoes with good ventilation"] },
  { key: "waterResistance", phrasings: ["waterproof shoes for rainy days", "something that keeps water out", "gear that survives a downpour"] },
  { key: "grip", phrasings: ["shoes with really good grip on wet ground", "non-slip soles", "something with serious traction"] },
  { key: "durability", phrasings: ["something hard-wearing that will last", "the most durable option", "built to take a beating"] },
  { key: "comfort", phrasings: ["the most comfortable option for all day", "something I can wear for twelve hours", "cushioned and easy on the feet"] },
  { key: "warmth", phrasings: ["something genuinely warm for winter", "the warmest layer you have"] },
  { key: "packability", phrasings: ["something that packs down small", "lightweight and easy to carry"] },
  { key: "batteryLife", phrasings: ["long battery life", "something I don't have to charge every day"] },
  { key: "noiseIsolation", phrasings: ["blocks out noise on a plane", "good noise cancelling"] },
  { key: "heatRetention", phrasings: ["keeps drinks hot all day", "something that holds heat"] },
  { key: "softness", phrasings: ["really soft against the skin"] },
  { key: "absorbency", phrasings: ["towels that actually dry you"] },
  { key: "sharpness", phrasings: ["a knife that stays sharp"] },
  { key: "support", phrasings: ["good arch support", "supportive for bad knees"] },
];

/** Pairs that genuinely trade off — the interesting retrieval case. */
const TRADE_OFFS: Array<{ high: QualityKey; low: QualityKey; query: string }> = [
  { high: "waterResistance", low: "breathability", query: "waterproof but I know it won't breathe well" },
  { high: "breathability", low: "waterResistance", query: "very breathable, I don't care about rain" },
  { high: "durability", low: "packability", query: "tough and heavy-duty, weight is not a concern" },
  { high: "warmth", low: "packability", query: "as warm as possible even if it's bulky" },
];

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const sqlClient = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(sqlClient, { schema });
  const rand = mulberry32(20260903);

  const cases: EvalCase[] = [];
  const add = (c: Omit<EvalCase, "id">) => {
    if (c.expectedProductIds.length === 0) return; // a case nothing satisfies proves nothing
    cases.push({ id: `eval-${(cases.length + 1).toString().padStart(3, "0")}`, ...c });
  };

  // ---- single attribute -------------------------------------------------
  for (const { key, phrasings } of ATTRIBUTE_QUERIES) {
    const rows = (await db.execute(sql`
      SELECT id FROM products
      WHERE status = 'active'
        AND (attributes->'qualities'->>${key})::int >= 4
      ORDER BY (attributes->'qualities'->>${key})::int DESC, title

    `)) as unknown as { id: string }[];

    for (const query of phrasings) {
      add({
        query,
        kind: "attribute",
        qualityConstraints: [{ key, op: "gte", value: 4 }],
        expectedProductIds: rows.map((r) => r.id),
        rationale: `${QUALITY_LABELS[key]} scored 4 or 5`,
      });
    }
  }

  // ---- trade-offs -------------------------------------------------------
  for (const { high, low, query } of TRADE_OFFS) {
    const rows = (await db.execute(sql`
      SELECT id FROM products
      WHERE status = 'active'
        AND (attributes->'qualities'->>${high})::int >= 4
        AND (attributes->'qualities'->>${low})::int <= 2
      ORDER BY title
    `)) as unknown as { id: string }[];

    add({
      query,
      kind: "trade-off",
      qualityConstraints: [
        { key: high, op: "gte", value: 4 },
        { key: low, op: "lte", value: 2 },
      ],
      expectedProductIds: rows.map((r) => r.id),
      rationale: `${QUALITY_LABELS[high]} >= 4 AND ${QUALITY_LABELS[low]} <= 2`,
    });
  }

  // ---- category recall --------------------------------------------------
  const categories = (await db.execute(sql`
    SELECT category, count(*)::int AS n FROM products WHERE status='active'
    GROUP BY category HAVING count(*) >= 4 ORDER BY category
  `)) as unknown as { category: string; n: number }[];

  for (const { category } of categories) {
    const rows = (await db.execute(sql`
      SELECT id FROM products WHERE status='active' AND category = ${category} ORDER BY title
    `)) as unknown as { id: string }[];
    add({
      query: category.toLowerCase(),
      kind: "category",
      expectedProductIds: rows.map((r) => r.id),
      rationale: `every active product in ${category}`,
    });
  }

  // ---- budget-constrained ----------------------------------------------
  for (const [label, max] of [["under 3000", 300000], ["under 8000", 800000]] as const) {
    const rows = (await db.execute(sql`
      SELECT DISTINCT p.id FROM products p
      JOIN product_variants v ON v.product_id = p.id
      JOIN inventory i ON i.variant_id = v.id
      WHERE p.status='active' AND v.active AND (i.quantity - i.reserved) > 0
        AND v.price_minor <= ${max}
        AND (p.attributes->'qualities'->>'comfort')::int >= 4

    `)) as unknown as { id: string }[];
    add({
      query: `comfortable shoes ${label} rupees`,
      kind: "budget",
      expectedProductIds: rows.map((r) => r.id),
      rationale: `comfort >= 4 with an in-stock variant at or below ${max / 100}`,
    });
  }

  // ---- paraphrase: the honesty check ------------------------------------
  //
  // Same ground truth as the attribute cases, but phrased WITHOUT naming the
  // feature — so no predicate can be extracted and retrieval has to do the
  // work. Without these, adding a filter would score ~1.0 by construction and
  // the eval would have stopped measuring anything.
  const PARAPHRASES: Array<{ key: QualityKey; query: string }> = [
    { key: "waterResistance", query: "something for walking the dog in a downpour" },
    { key: "breathability", query: "my feet get unbearably hot in the afternoon" },
    { key: "warmth", query: "I am always cold at the bus stop in January" },
    { key: "durability", query: "the last pair fell apart in three months" },
    { key: "comfort", query: "I am on my feet from six in the morning" },
    { key: "grip", query: "I keep slipping on the wet path to the station" },
    { key: "noiseIsolation", query: "the open-plan office is unbearable" },
    { key: "batteryLife", query: "I keep running out of charge on the train home" },
    { key: "packability", query: "everything has to fit in one carry-on" },
    { key: "heatRetention", query: "my coffee is cold by the time I get to work" },
  ];

  for (const { key, query } of PARAPHRASES) {
    const rows = (await db.execute(sql`
      SELECT id FROM products
      WHERE status = 'active' AND (attributes->'qualities'->>${key})::int >= 4
      ORDER BY title
    `)) as unknown as { id: string }[];

    add({
      query,
      kind: "paraphrase",
      // No constraints on purpose — this is the held-out measurement.
      expectedProductIds: rows.map((r) => r.id),
      rationale: `${QUALITY_LABELS[key]} >= 4, described without naming it`,
    });
  }

  // ---- negation: the case retrieval usually gets wrong -------------------
  const notWaterproof = (await db.execute(sql`
    SELECT id FROM products
    WHERE status='active' AND (attributes->'qualities'->>'waterResistance')::int <= 2
    ORDER BY title
  `)) as unknown as { id: string }[];
  add({
    query: "shoes that are definitely not waterproof, I want maximum airflow",
    kind: "negation",
    qualityConstraints: [{ key: "waterResistance", op: "lte", value: 2 }],
    expectedProductIds: notWaterproof.map((r) => r.id),
    rationale: "water resistance <= 2 — tests that a negated term is not treated as a positive one",
  });

  // A second negation, phrased the other way round.
  const notHeavy = (await db.execute(sql`
    SELECT id FROM products
    WHERE status='active' AND (attributes->'qualities'->>'warmth')::int <= 2
    ORDER BY title
  `)) as unknown as { id: string }[];
  add({
    query: "something light that is not warm at all, for summer",
    kind: "negation",
    qualityConstraints: [{ key: "warmth", op: "lte", value: 2 }],
    expectedProductIds: notHeavy.map((r) => r.id),
    rationale: "warmth <= 2",
  });

  // Shuffle so an eval run does not walk the categories in order.
  for (let i = cases.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cases[i], cases[j]] = [cases[j], cases[i]];
  }

  mkdirSync("eval", { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    note:
      "Ground truth is computed from the quality scores that generated the catalogue, " +
      "so it is exact rather than judged. Regenerate after any change to the catalogue.",
    cases,
  };
  writeFileSync("eval/retrieval-eval.json", JSON.stringify(payload, null, 2));

  const byKind = cases.reduce<Record<string, number>>((acc, c) => {
    acc[c.kind] = (acc[c.kind] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`
wrote eval/retrieval-eval.json
  cases      ${cases.length}
  by kind    ${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(", ")}
  avg expected products per case ${(cases.reduce((s, c) => s + c.expectedProductIds.length, 0) / cases.length).toFixed(1)}
`);
  await sqlClient.end();
}

main().catch((error) => { console.error(error); process.exit(1); });
