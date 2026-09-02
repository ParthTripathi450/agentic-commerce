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

export async function generateProductImage(
  prompt: string,
  seed: number,
  timeoutMs = 120_000,
): Promise<GeneratedImage> {
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?width=${IMAGE_SIZE}&height=${IMAGE_SIZE}&nologo=true&seed=${seed}`;

  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`image service returned ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  // The service answers errors with 200 and an HTML body, so check the bytes.
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  if (!isJpeg && !isPng) {
    throw new Error("response was not an image");
  }
  if (bytes.length < 2000) {
    throw new Error(`image suspiciously small (${bytes.length} bytes)`);
  }

  return { bytes, contentType: isJpeg ? "image/jpeg" : "image/png" };
}
