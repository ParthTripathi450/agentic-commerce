import { createHash } from "node:crypto";

/**
 * Product image generation.
 *
 * Uses Pollinations, which serves generated images over a plain GET with no API
 * key, no account and no card — the same constraint every other service in this
 * project is held to. Nothing runs locally, so it costs the developer's machine
 * nothing.
 *
 * Images are decorative here: agents rank on text and structured attributes, so
 * a generated image never influences search results. It exists so a human
 * looking at the agent's recommendation sees a product rather than a grey box.
 */

export const IMAGE_SIZE = 768;

export type ImagePromptInput = {
  title: string;
  category: string;
  brand: string | null;
  /** Dominant variant colour, when the product has one. */
  color?: string | null;
  attributes?: Record<string, unknown>;
};

/**
 * Builds the prompt.
 *
 * Colour leads, because these models drift on it when it appears late — asking
 * for "black running shoes" at the end of a sentence reliably produced grey.
 */
export function buildImagePrompt(input: ImagePromptInput): string {
  const material =
    typeof input.attributes?.material === "string" ? input.attributes.material : null;
  const use = typeof input.attributes?.use === "string" ? input.attributes.use : null;

  const subject = [
    input.color ? `${input.color.toUpperCase()} coloured` : null,
    input.title.replace(/\b\d+(mm|L|ml|mAh|W)\b/gi, "").trim(),
    material ? `made of ${material}` : null,
    use ? `for ${use}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return [
    subject,
    "single product, professional e-commerce catalogue photograph",
    "centred on a plain white seamless studio background",
    "soft even lighting, subtle contact shadow, sharp focus, high detail",
    "no text, no logo, no watermark, no people",
  ].join(", ");
}

/** Stable seed per product, so re-running produces the same catalogue. */
export function seedFor(key: string): number {
  return parseInt(createHash("sha256").update(key).digest("hex").slice(0, 8), 16) % 2_000_000;
}

export type GeneratedImage = { bytes: Uint8Array; contentType: string };

/**
 * How hard the free tier may be pushed.
 *
 * Measured, not guessed: three concurrent anonymous requests returned two 429s
 * and six returned five. The service admits roughly ONE request in flight, so
 * there is no throughput to win by parallelising — raising this earns rate-limit
 * errors, not images. What actually makes a run finish is retrying, because a
 * 429 means "in a moment", not "never".
 */
export const SAFE_CONCURRENCY = 1;

/** Statuses worth trying again. Anything else is the request's own fault. */
function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

export class ImageServiceError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ImageServiceError";
  }
}

async function requestImage(
  prompt: string,
  seed: number,
  timeoutMs: number,
): Promise<GeneratedImage> {
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?width=${IMAGE_SIZE}&height=${IMAGE_SIZE}&nologo=true&seed=${seed}`;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // A timeout or dropped connection is the service being busy, not a bad
    // request — the single most common way a long run used to lose an image.
    throw new ImageServiceError(`request failed: ${(error as Error).name}`, true);
  }

  if (!response.ok) {
    throw new ImageServiceError(
      `image service returned ${response.status}`,
      isRetryable(response.status),
      response.status,
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  // The service answers some errors with 200 and an HTML body, so check the
  // bytes rather than trusting the status.
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  if (!isJpeg && !isPng) {
    throw new ImageServiceError("response was not an image", true);
  }
  if (bytes.length < 2000) {
    throw new ImageServiceError(`image suspiciously small (${bytes.length} bytes)`, true);
  }

  return { bytes, contentType: isJpeg ? "image/jpeg" : "image/png" };
}

/**
 * Fetches one image, retrying the failures that are worth retrying.
 *
 * This is the whole difference between a run that finishes and one that does
 * not. Without it a single rate-limit reply abandoned that image for the rest
 * of the run — a batch of forty produced three, and the other thirty-seven
 * looked like permanent failures when every one of them was "ask again in ten
 * seconds". Backoff is exponential with jitter so a batch that hits the limit
 * does not resynchronise and hit it again together on the next attempt.
 */
export async function generateProductImage(
  prompt: string,
  seed: number,
  options: { timeoutMs?: number; attempts?: number; onRetry?: (info: RetryInfo) => void } = {},
): Promise<GeneratedImage> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const attempts = Math.max(1, options.attempts ?? 5);

  let lastError: ImageServiceError | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await requestImage(prompt, seed, timeoutMs);
    } catch (error) {
      const failure =
        error instanceof ImageServiceError
          ? error
          : new ImageServiceError((error as Error).message, false);
      lastError = failure;

      if (!failure.retryable || attempt === attempts) break;

      const backoffMs = Math.round(2_000 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
      options.onRetry?.({ attempt, of: attempts, waitMs: backoffMs, reason: failure.message });
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  throw lastError ?? new ImageServiceError("image generation failed", false);
}

export type RetryInfo = { attempt: number; of: number; waitMs: number; reason: string };
