import { randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";

/**
 * Product image storage.
 *
 * Two drivers behind one interface, matching the pattern used for AI providers
 * and payments: `local` writes into ./public/uploads so the platform is fully
 * usable with no account anywhere, and `supabase` uses Supabase Storage's free
 * tier (no card) once deployed, where a serverless filesystem is not writable.
 */

export const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Allowed types, checked against the file's MAGIC BYTES rather than the
 * client-supplied Content-Type — which is trivially forged.
 */
const SIGNATURES: Array<{ mime: string; ext: string; test: (b: Uint8Array) => boolean }> = [
  { mime: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: "image/png",
    ext: "png",
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    mime: "image/webp",
    ext: "webp",
    test: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
  {
    mime: "image/gif",
    ext: "gif",
    test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  },
];

export type DetectedType = { mime: string; ext: string };

export function detectImageType(bytes: Uint8Array): DetectedType | null {
  const match = SIGNATURES.find((s) => s.test(bytes));
  return match ? { mime: match.mime, ext: match.ext } : null;
}

export type StoredFile = { url: string; key: string };

export interface StorageDriver {
  readonly name: string;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<StoredFile>;
  remove(key: string): Promise<void>;
}

/** Writes under ./public/uploads. Fine for local use; not for serverless. */
class LocalDriver implements StorageDriver {
  readonly name = "local";
  private root = path.join(process.cwd(), "public", "uploads");

  // Content type is implied by the file extension when served from /public.
  async put(key: string, bytes: Uint8Array): Promise<StoredFile> {
    const target = path.join(this.root, key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return { url: `/uploads/${key}`, key };
  }

  async remove(key: string): Promise<void> {
    await unlink(path.join(this.root, key)).catch(() => {
      // Already gone is the desired end state.
    });
  }
}

/** Supabase Storage over its REST API — no SDK needed for put and delete. */
class SupabaseDriver implements StorageDriver {
  readonly name = "supabase";

  private config() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? "product-images";
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    /*
     * Accept the URL the dashboard actually hands you.
     *
     * Supabase shows a "RESTful API" URL ending in /rest/v1/ alongside the bare
     * project URL, and pasting the wrong one sends storage calls to PostgREST,
     * which answers 404 PGRST125 — an error about a database path, for an
     * upload. Trimming the known service suffixes here costs nothing and turns
     * a confusing failure into no failure.
     */
    const base = url.replace(/\/+$/, "").replace(/\/(rest|storage|auth|realtime)\/v1$/, "");
    return { url: base, key, bucket };
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<StoredFile> {
    const { url, key: token, bucket } = this.config();
    const response = await fetch(`${url}/storage/v1/object/${bucket}/${key}`, {
      method: "POST",
      headers: {
        /*
         * BOTH headers, and both are required.
         *
         * Supabase puts an API gateway in front of Storage, and the gateway
         * authenticates on `apikey` while Storage itself authorises on the
         * bearer token. Sending only the bearer gets you a 401 from the gateway
         * that never reaches Storage — "No API key found in request" — which
         * reads like a bad key rather than a missing header.
         */
        apikey: token,
        Authorization: `Bearer ${token}`,
        "Content-Type": contentType,
        "x-upsert": "true",
      },
      body: bytes as unknown as BodyInit,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Supabase upload failed: ${response.status} ${await response.text()}`);
    }
    return { url: `${url}/storage/v1/object/public/${bucket}/${key}`, key };
  }

  async remove(key: string): Promise<void> {
    const { url, key: token, bucket } = this.config();
    await fetch(`${url}/storage/v1/object/${bucket}/${key}`, {
      method: "DELETE",
      headers: { apikey: token, Authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  }
}

let cached: StorageDriver | null = null;

export function storage(): StorageDriver {
  if (cached) return cached;
  const driver = process.env.STORAGE_DRIVER ?? (process.env.SUPABASE_URL ? "supabase" : "local");
  cached = driver === "supabase" ? new SupabaseDriver() : new LocalDriver();
  return cached;
}

export function resetStorageCache() {
  cached = null;
}

/** Namespaced, unguessable key. Merchant prefix keeps buckets browsable. */
export function buildKey(merchantSlug: string, productId: string, ext: string): string {
  return `${merchantSlug}/${productId}/${randomUUID()}.${ext}`;
}

export type UploadValidation =
  | { ok: true; bytes: Uint8Array; type: DetectedType }
  | { ok: false; error: string };

/** Validates size and real file type before anything is written. */
export async function validateUpload(file: File): Promise<UploadValidation> {
  if (file.size === 0) return { ok: false, error: "That file is empty." };
  if (file.size > MAX_BYTES) {
    return { ok: false, error: `Images must be under ${MAX_BYTES / 1024 / 1024}MB.` };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = detectImageType(bytes);
  if (!type) {
    return {
      ok: false,
      error: "That is not a JPEG, PNG, WebP or GIF image. (The file's own contents were checked, not its name.)",
    };
  }
  return { ok: true, bytes, type };
}

export { env };
