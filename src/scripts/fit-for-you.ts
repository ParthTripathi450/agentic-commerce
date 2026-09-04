import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Searches for better affinity axis weights than the hand-picked ones.
 *
 *   npm run eval:fit-for-you
 *
 * Reports and stops. Nothing is applied: these orders are generated, so a
 * fitted set encodes the seed's habits rather than human taste, and the held-out
 * column is the only one worth believing.
 */
async function main() {
  const { fitAxisWeights } = await import("@/server/shopper/fit-weights");
  const { DEFAULT_AXES } = await import("@/server/agents/customer/affinity");

  console.log("fitting affinity weights (coordinate descent, cross-validated)…\n");
  const startedAt = Date.now();
  const result = await fitAxisWeights();

  console.log(`  ${result.shoppers} shoppers, ${result.folds} folds\n`);
  console.log(`  ${"MRR".padEnd(12)} ${"train".padStart(8)} ${"held out".padStart(10)}`);
  console.log(`  ${"hand-picked".padEnd(12)} ${result.baseline.train.toFixed(4).padStart(8)} ${result.baseline.test.toFixed(4).padStart(10)}`);
  console.log(`  ${"fitted".padEnd(12)} ${result.fitted.train.toFixed(4).padStart(8)} ${result.fitted.test.toFixed(4).padStart(10)}`);

  console.log(`\n  ${"axis".padEnd(10)} ${"hand".padStart(6)} ${"fitted".padStart(8)}`);
  for (const key of Object.keys(result.axes) as (keyof typeof result.axes)[]) {
    console.log(
      `  ${key.padEnd(10)} ${String(DEFAULT_AXES[key]).padStart(6)} ${String(result.axes[key]).padStart(8)}`,
    );
  }

  console.log(
    result.generalises
      ? "\n  The gain survives on shoppers the search never saw — worth considering."
      : "\n  The gain does NOT survive on held-out shoppers: this is the search fitting\n" +
        "  individuals, not learning taste. Keep the hand-picked weights.",
  );
  console.log(`\n  Nothing was applied. Edit DEFAULT_AXES yourself if you want these to ship.`);
  console.log(`\ndone in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
