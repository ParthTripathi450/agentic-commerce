import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });

/**
 * How good are the "For you" suggestions, really?
 *
 *   npm run eval:for-you
 *
 * Holds back each repeat shopper's most recent purchase, rebuilds their profile
 * from what was known before it, and reports how highly the thing they actually
 * bought is ranked — against popularity and random on the identical candidate
 * set, because a personalisation that cannot beat "show the bestsellers" is not
 * personalisation.
 */
async function main() {
  const { evaluateForYou } = await import("@/server/shopper/for-you-eval");
  const startedAt = Date.now();

  const result = await evaluateForYou();

  const row = (label: string, m: { recallAt10: number; recallAt20: number; mrr: number }) =>
    `  ${label.padEnd(14)} ${m.recallAt10.toFixed(3).padStart(9)} ${m.recallAt20
      .toFixed(3)
      .padStart(10)} ${m.mrr.toFixed(3).padStart(7)}`;

  console.log(
    `\nfor-you eval — ${result.cases} shoppers, ${result.candidates} candidates each` +
      (result.skipped > 0 ? ` (${result.skipped} skipped: nothing known before the cutoff)` : ""),
  );
  console.log(`  ${"ranking".padEnd(14)} ${"recall@10".padStart(9)} ${"recall@20".padStart(10)} ${"MRR".padStart(7)}`);
  console.log(row("affinity", result.affinity));
  console.log(row("popularity", result.popularity));
  console.log(row("random", result.random));

  const beatsPopularity = result.affinity.mrr > result.popularity.mrr;
  const beatsRandom = result.affinity.mrr > result.random.mrr;
  console.log(
    `\n  vs random     : ${beatsRandom ? "better" : "NOT better"}` +
      `\n  vs popularity : ${beatsPopularity ? "better" : "NOT better"}`,
  );
  if (!beatsPopularity) {
    console.log("  the profile is not yet earning its place — popularity alone does as well.");
  }
  console.log(`\ndone in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
