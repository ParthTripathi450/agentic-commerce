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
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
