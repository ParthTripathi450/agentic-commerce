import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Generates a catalogue image for every product that lacks one.
 *
 * Sequential with a small pause: the image service is free and unauthenticated,
 * so hammering it in parallel is both rude and a good way to get throttled.
 * Re-runnable — products that already have an image are skipped unless --force.
 */
async function main() {
  const { db } = await import("@/db");
  const { products, productVariants } = await import("@/db/schema");
  const { eq, sql } = await import("drizzle-orm");
  const { buildImagePrompt, generateProductImage, seedFor } = await import("@/server/ai/images");
  const { storage, buildKey } = await import("@/server/storage");

  const force = process.argv.includes("--force");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;

  const rows = (await db.execute<Record<string, string>>(sql`
    SELECT p.id, p.title, p.category, p.brand, p.attributes, p.image_urls,
           m.slug AS merchant_slug,
           (SELECT v.attributes->>'color' FROM product_variants v
             WHERE v.product_id = p.id AND v.attributes ? 'color'
             ORDER BY v.sku LIMIT 1) AS color
    FROM products p
    JOIN merchants m ON m.id = p.merchant_id
    WHERE p.status = 'active'
    ORDER BY p.title
  `)) as unknown as Record<string, string>[];

  const pending = rows
    .filter((row) => force || ((row.image_urls as unknown as string[]) ?? []).length === 0)
    .slice(0, limit);

  console.log(
    `${rows.length} active products · ${pending.length} to generate` +
      (force ? " (forced)" : "") +
      `\nstorage driver: ${storage().name}\n`,
  );

  let done = 0;
  let failed = 0;

  for (const row of pending) {
    const prompt = buildImagePrompt({
      title: row.title,
      category: row.category,
      brand: row.brand ?? null,
      color: row.color ?? null,
      attributes: (row.attributes as unknown as Record<string, unknown>) ?? {},
    });

    try {
      const image = await generateProductImage(prompt, seedFor(row.id));
      const ext = image.contentType === "image/png" ? "png" : "jpg";
      const stored = await storage().put(
        buildKey(row.merchant_slug, row.id, ext),
        image.bytes,
        image.contentType,
      );

      await db
        .update(products)
        .set({ imageUrls: [stored.url], updatedAt: new Date() })
        .where(eq(products.id, row.id));

      done++;
      console.log(`  ✓ ${row.title.slice(0, 46).padEnd(48)} ${(image.bytes.length / 1024).toFixed(0)}KB`);
    } catch (cause) {
      failed++;
      console.log(`  ✗ ${row.title.slice(0, 46).padEnd(48)} ${(cause as Error).message}`);
    }

    // Be a good citizen of a free, unauthenticated service.
    await new Promise((resolve) => setTimeout(resolve, 700));
  }

  console.log(`\n${done} generated, ${failed} failed.`);
  if (failed > 0) console.log("Re-run to retry the failures — successes are skipped.");
  void productVariants;
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
