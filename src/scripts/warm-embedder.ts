/**
 * Download the sentence model into the package cache before a build.
 *
 *   npm run prebuild        (runs automatically before `npm run build`)
 *
 * The deployed function needs the weights on disk: `search.ts` embeds the
 * shopper's query at request time, and a serverless container that has to fetch
 * 86MB first would pay that on every cold start, into a /tmp that does not
 * survive one. Fetching at build time turns a per-request cost into a one-off,
 * and `outputFileTracingIncludes` in next.config.ts ships what this leaves
 * behind.
 *
 * **Deliberately does not import the app's `embed()`.** That module reads the
 * validated environment, which requires a database URL — and downloading model
 * weights has nothing to do with a database. Going through it made the warm
 * step fail on any machine that builds without `.env.local`, which is every CI
 * machine, which is the only place this actually matters.
 *
 * It also never fails the build. A hiccup on the model host should not stop a
 * deploy; the runtime can still fetch the weights itself, more slowly. It says
 * so loudly instead.
 */
async function main() {
  const model = process.env.EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2";
  const started = Date.now();

  try {
    const { pipeline } = await import("@huggingface/transformers");
    // Same task and dtype as `src/server/ai/embeddings.ts`. A different dtype
    // would cache different weights AND produce different vectors, silently
    // invalidating every embedding already in the database.
    const extractor = await pipeline("feature-extraction", model, { dtype: "fp32" });
    const out = await extractor(["warming the embedding model for this build"], {
      pooling: "mean",
      normalize: true,
    });
    const dims = (out.tolist() as number[][])[0].length;
    console.log(`embedder warm: ${model}, ${dims} dimensions, ${((Date.now() - started) / 1000).toFixed(1)}s`);
    await extractor.dispose();
  } catch (cause) {
    console.warn(`\n  WARNING: could not warm the embedding model — ${(cause as Error).message}`);
    console.warn(`  The build continues; cold starts will download it at runtime instead.\n`);
  }
  process.exit(0);
}

void main();
