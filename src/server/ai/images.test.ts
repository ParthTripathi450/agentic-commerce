import { afterEach, describe, expect, it, vi } from "vitest";
import { buildImagePrompt, generateProductImage, SAFE_CONCURRENCY } from "./images";

/**
 * The retry is the whole reason a long image run finishes.
 *
 * Without it a single rate-limit reply abandoned that image for the rest of the
 * run: a batch of forty produced three, and the other thirty-seven looked like
 * permanent failures when every one of them was "ask again in a moment".
 */

const JPEG = () => {
  const bytes = new Uint8Array(4000);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  return bytes;
};

const ok = () => new Response(JPEG(), { status: 200 });
const status = (code: number) => new Response("nope", { status: code });

afterEach(() => vi.restoreAllMocks());

describe("generateProductImage", () => {
  it("retries a 429 rather than treating it as a permanent failure", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(status(429))
      .mockResolvedValueOnce(status(429))
      .mockResolvedValueOnce(ok());

    const image = await generateProductImage("a shoe", 1, { attempts: 5 });

    expect(image.contentType).toBe("image/jpeg");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a 5xx and a timeout", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(status(500))
      .mockRejectedValueOnce(Object.assign(new Error("timed out"), { name: "TimeoutError" }))
      .mockResolvedValueOnce(ok());

    await expect(generateProductImage("a shoe", 1, { attempts: 4 })).resolves.toBeTruthy();
  });

  it("does not retry a request that is its own fault", async () => {
    // A 400 will fail identically forever; retrying it just burns the budget
    // that the retryable failures needed.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(status(400));

    await expect(generateProductImage("a shoe", 1, { attempts: 5 })).rejects.toThrow("400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after the attempt budget and reports the real reason", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(status(429));

    await expect(generateProductImage("a shoe", 1, { attempts: 2 })).rejects.toThrow("429");
  });

  it("reports each retry so a long run is not silent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(status(429)).mockResolvedValueOnce(ok());

    const seen: string[] = [];
    await generateProductImage("a shoe", 1, {
      attempts: 3,
      onRetry: (info) => seen.push(`${info.attempt}/${info.of}: ${info.reason}`),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("429");
  });

  it("rejects a 200 that is not actually an image", async () => {
    // The service answers some errors with 200 and an HTML body, so the status
    // cannot be trusted on its own.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>error</html>", { status: 200 }),
    );

    await expect(generateProductImage("a shoe", 1, { attempts: 1 })).rejects.toThrow("not an image");
  });

  it("stays serial, because the service admits one request at a time", () => {
    // Measured, not assumed: 3 concurrent anonymous requests returned two 429s
    // and 6 returned five. Raising this earns rate-limit errors, not images.
    expect(SAFE_CONCURRENCY).toBe(1);
  });
});

describe("buildImagePrompt", () => {
  it("leads with the colour", () => {
    // These models drift on colour when it appears late — asking for "black
    // running shoes" at the end of a sentence reliably produced grey.
    const prompt = buildImagePrompt({
      title: "Velocity Run 3",
      category: "Running Shoes",
      brand: "Stride",
      color: "navy",
    });

    expect(prompt.indexOf("NAVY")).toBeLessThan(prompt.indexOf("Velocity"));
  });
});
