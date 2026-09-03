import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });

async function main() {
  const { indexCatalog, pruneCatalog } = await import("@/server/catalog/indexer");
  const force = process.argv.includes("--force");

  console.log(`indexing catalog${force ? " (forced rebuild)" : ""}…`);
  const result = await indexCatalog({
    force,
    onProgress: (done, total) => {
      if (done % 32 === 0 || done === total) {
        process.stdout.write(`\r  embedded ${done}/${total}`);
      }
    },
  });
  const pruned = await pruneCatalog();

  console.log(
    `\ndone in ${(result.durationMs / 1000).toFixed(1)}s — ` +
      `${result.indexed} indexed, ${result.skipped} unchanged, ${pruned} pruned, ${result.total} total`,
  );

  // Review chunks are embedded separately so a product's own vector stays about
  // the product; see server/catalog/evidence-indexer.ts.
  const { indexEvidence } = await import("@/server/catalog/evidence-indexer");
  console.log("\nindexing review evidence…");
  const evidence = await indexEvidence({
    force,
    onProgress: (done, total) => {
      if (done % 128 === 0 || done === total) {
        process.stdout.write(`\r  embedded ${done}/${total}`);
      }
    },
  });
  console.log(
    `\ndone in ${(evidence.durationMs / 1000).toFixed(1)}s — ` +
      `${evidence.indexed} chunks indexed, ${evidence.skipped} unchanged, ${evidence.total} total`,
  );

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
