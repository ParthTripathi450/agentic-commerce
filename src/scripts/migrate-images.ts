import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Move locally-stored product images into the configured object store.
 *
 *   npm run images:migrate -- --dry-run
 *   npm run images:migrate
 *
 * The local driver writes under `public/uploads`, which works on a laptop and
 * nowhere else: that directory is git-ignored, so it never reaches a deployment,
 * and a serverless filesystem is read-only anyway. Left alone, a deployed
 * catalogue shows 367 products with broken images and every new upload throws.
 *
 * Two columns hold these paths — `products.image_urls` (a JSON array) and
 * `product_variants.image_url` — and BOTH must move together. Migrating one
 * leaves the product page showing a picture the colour picker cannot match.
 *
 * **Idempotent and resumable.** Rows already pointing at an absolute URL are
 * skipped, so an interrupted run is fixed by running it again. The local file
 * is never deleted: until the new URL is confirmed serving, it is the only
 * copy that exists.
 */
const DRY = process.argv.includes("--dry-run");

async function main() {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { db } = await import("@/db");
  const { sql } = await import("drizzle-orm");
  const { storage } = await import("@/server/storage");

  const driver = storage();
  if (driver.name === "local" && !DRY) {
    console.log(
      `\n  STORAGE_DRIVER resolves to "local", so this would copy the files onto\n` +
        `  themselves. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (and\n` +
        `  STORAGE_DRIVER=supabase) in .env.local first.\n`,
    );
    process.exit(1);
  }

  const q = async (t: ReturnType<typeof sql>) =>
    (await db.execute(t)) as unknown as Record<string, unknown>[];

  const products = await q(sql`
    SELECT id, image_urls FROM products
    WHERE image_urls::text LIKE '%/uploads/%'`);
  const variants = await q(sql`
    SELECT id, image_url FROM product_variants
    WHERE image_url LIKE '/uploads/%'`);

  console.log(
    `${DRY ? "[dry run] " : ""}${products.length} product row(s), ${variants.length} variant row(s) to move\n`,
  );

  // One upload per distinct FILE, however many rows point at it. Products and
  // variants share images constantly; uploading per row would send the same
  // bytes a dozen times and burn the storage quota doing it.
  const uploaded = new Map<string, string>();
  let failures = 0;

  async function move(localUrl: string): Promise<string | null> {
    const cached = uploaded.get(localUrl);
    if (cached) return cached;

    const key = localUrl.replace(/^\/uploads\//, "");
    const file = path.join(process.cwd(), "public", "uploads", key);
    try {
      const bytes = await readFile(file);
      const ext = path.extname(key).toLowerCase();
      const type =
        ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";

      if (DRY) {
        uploaded.set(localUrl, `[would upload ${(bytes.length / 1024).toFixed(0)}KB]`);
        return uploaded.get(localUrl)!;
      }
      const stored = await driver.put(key, bytes, type);
      uploaded.set(localUrl, stored.url);
      return stored.url;
    } catch (cause) {
      // A missing file is reported and skipped, never written as a broken URL:
      // a row still pointing at /uploads is a row a re-run can fix.
      console.warn(`  SKIP ${key} — ${(cause as Error).message}`);
      failures++;
      return null;
    }
  }

  for (const row of products) {
    const urls = (row.image_urls ?? []) as string[];
    const next: string[] = [];
    for (const u of urls) next.push(u.startsWith("/uploads/") ? ((await move(u)) ?? u) : u);
    if (!DRY && next.some((u, i) => u !== urls[i])) {
      await q(sql`UPDATE products SET image_urls = ${JSON.stringify(next)}::jsonb WHERE id = ${String(row.id)}`);
    }
  }

  for (const row of variants) {
    const moved = await move(String(row.image_url));
    if (!DRY && moved) {
      await q(sql`UPDATE product_variants SET image_url = ${moved} WHERE id = ${String(row.id)}`);
    }
  }

  console.log(`\n  ${uploaded.size} distinct file(s) ${DRY ? "would be" : ""} uploaded`);
  if (failures) console.log(`  ${failures} file(s) missing on disk — re-run after restoring them`);

  if (!DRY) {
    const [left] = await q(sql`
      SELECT (SELECT count(*) FROM products WHERE image_urls::text LIKE '%/uploads/%')
           + (SELECT count(*) FROM product_variants WHERE image_url LIKE '/uploads/%') AS n`);
    console.log(`  ${left.n} row(s) still pointing at local storage`);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
