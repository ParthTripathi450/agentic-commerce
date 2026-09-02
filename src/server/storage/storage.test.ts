import { describe, expect, it } from "vitest";
import { detectImageType, MAX_BYTES, buildKey, validateUpload } from "./index";

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
const webp = () =>
  new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

function fileFrom(bytes: Uint8Array, name: string, type: string) {
  return new File([bytes as unknown as BlobPart], name, { type });
}

describe("upload validation", () => {
  it("identifies real image formats by their magic bytes", () => {
    expect(detectImageType(png())?.mime).toBe("image/png");
    expect(detectImageType(jpeg())?.mime).toBe("image/jpeg");
    expect(detectImageType(webp())?.mime).toBe("image/webp");
  });

  it("rejects a non-image even when it is named and typed as one", async () => {
    // The classic bypass: rename evil.html to photo.png and set the MIME type.
    const disguised = new TextEncoder().encode("<script>alert(1)</script>");
    const result = await validateUpload(fileFrom(disguised, "photo.png", "image/png"));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/not a JPEG/i);
  });

  it("accepts a genuine image regardless of a wrong declared type", async () => {
    const result = await validateUpload(fileFrom(png(), "whatever.bin", "application/octet-stream"));
    expect(result.ok).toBe(true);
    expect(result.ok && result.type.ext).toBe("png");
  });

  it("rejects an empty file", async () => {
    const result = await validateUpload(fileFrom(new Uint8Array(), "empty.png", "image/png"));
    expect(result.ok).toBe(false);
  });

  it("rejects a file over the size limit", async () => {
    const oversized = new Uint8Array(MAX_BYTES + 1);
    oversized.set(png(), 0);
    const result = await validateUpload(fileFrom(oversized, "big.png", "image/png"));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/under/i);
  });

  it("builds keys that cannot collide or be guessed", () => {
    const a = buildKey("stride-athletics", "prod-1", "png");
    const b = buildKey("stride-athletics", "prod-1", "png");
    expect(a).not.toBe(b);
    expect(a.startsWith("stride-athletics/prod-1/")).toBe(true);
    expect(a.endsWith(".png")).toBe(true);
  });
});
