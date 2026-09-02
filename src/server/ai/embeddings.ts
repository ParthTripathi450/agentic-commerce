import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { EMBEDDING_DIMENSIONS, env } from "@/lib/env";

/**
 * Embeddings run locally on CPU via transformers.js.
 *
 * This is the one piece of AI infrastructure with no API key, no rate limit and
 * no quota at all — which matters, because indexing a catalog is exactly the
 * kind of bulk workload that would exhaust a free LLM tier in one run. The model
 * (~25MB) downloads once to ./.cache on first use.
 */

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", env().EMBEDDING_MODEL, {
      dtype: "fp32",
    });
  }
  return extractorPromise;
}

/** Embeds a batch of texts into L2-normalised 384-dimensional vectors. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  const vectors = output.tolist() as number[][];

  for (const v of vectors) {
    if (v.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding model returned ${v.length} dimensions, schema expects ${EMBEDDING_DIMENSIONS}`,
      );
    }
  }
  return vectors;
}

export async function embedOne(text: string): Promise<number[]> {
  const [vector] = await embed([text]);
  return vector;
}

/** Frees the model between long-running batch jobs. */
export async function disposeEmbedder() {
  if (!extractorPromise) return;
  const extractor = await extractorPromise;
  await extractor.dispose();
  extractorPromise = null;
}
