import { config as loadEnv } from "dotenv";
import { readFileSync } from "node:fs";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Measures retrieval against the labelled eval set.
 *
 * Reports recall@k and MRR per case KIND, not just overall, because the kinds
 * fail for different reasons: a bad `attribute` score means the quality words
 * are not reaching the embedding, a bad `negation` score means "not waterproof"
 * is being read as "waterproof", and those need opposite fixes.
 */

type EvalCase = {
  id: string;
  query: string;
  kind: string;
  expectedProductIds: string[];
  rationale: string;
};

const K = 10;

function recallAtK(retrieved: string[], expected: Set<string>, k: number): number {
  if (expected.size === 0) return 1;
  const hits = retrieved.slice(0, k).filter((id) => expected.has(id)).length;
  // Capped: a case with 40 expected products cannot score above k/expected.
  return hits / Math.min(k, expected.size);
}

function reciprocalRank(retrieved: string[], expected: Set<string>): number {
  const index = retrieved.findIndex((id) => expected.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

async function main() {
  const { hybridSearch } = await import("@/server/catalog/search");
  const payload = JSON.parse(readFileSync("eval/retrieval-eval.json", "utf8")) as {
    cases: EvalCase[];
  };

  const byKind = new Map<string, { recall: number[]; mrr: number[] }>();
  const worst: Array<{ id: string; query: string; recall: number; rationale: string }> = [];

  for (const testCase of payload.cases) {
    const result = await hybridSearch({
      text: testCase.query,
      limit: K,
      requireInStock: false,
    });
    const retrieved = result.candidates.map((c) => c.productId);
    const expected = new Set(testCase.expectedProductIds);

    const recall = recallAtK(retrieved, expected, K);
    const mrr = reciprocalRank(retrieved, expected);

    const bucket = byKind.get(testCase.kind) ?? { recall: [], mrr: [] };
    bucket.recall.push(recall);
    bucket.mrr.push(mrr);
    byKind.set(testCase.kind, bucket);

    worst.push({ id: testCase.id, query: testCase.query, recall, rationale: testCase.rationale });
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

  console.log(`\nretrieval eval — ${payload.cases.length} cases, k=${K}\n`);
  console.log("  kind          cases   recall@10   MRR");
  console.log("  ─────────────────────────────────────");
  for (const [kind, bucket] of [...byKind.entries()].sort()) {
    console.log(
      `  ${kind.padEnd(12)}  ${String(bucket.recall.length).padStart(5)}   ` +
        `${mean(bucket.recall).toFixed(3).padStart(9)}   ${mean(bucket.mrr).toFixed(3)}`,
    );
  }

  const allRecall = [...byKind.values()].flatMap((b) => b.recall);
  const allMrr = [...byKind.values()].flatMap((b) => b.mrr);
  console.log("  ─────────────────────────────────────");
  console.log(`  ${"OVERALL".padEnd(12)}  ${String(allRecall.length).padStart(5)}   ${mean(allRecall).toFixed(3).padStart(9)}   ${mean(allMrr).toFixed(3)}`);

  const failures = worst.filter((w) => w.recall < 0.3).sort((a, b) => a.recall - b.recall);
  if (failures.length) {
    console.log(`\n  weakest ${Math.min(8, failures.length)} cases:`);
    for (const f of failures.slice(0, 8)) {
      console.log(`    ${f.recall.toFixed(2)}  "${f.query}"\n          expected: ${f.rationale}`);
    }
  }
  console.log();
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
