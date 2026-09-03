import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Photographs each COLOUR of a product, so changing colour changes the picture.
 *
 * Only colour earns its own image. Sizes of the same shoe photograph
 * identically, so a per-variant image for every row would be thousands of
 * near-duplicate renders for no visible difference — this generates one per
 * distinct (product, colour) and shares it across that colour's sizes.
 *
 * The prompt is built from the product's own title and attributes with only the
 * colour swapped, and every colour of a product uses the SAME seed, so the
 * renders are the same garment in different colours rather than different
 * garments that happen to share a name.
 *
 * **This runs serially on purpose.** The image service admits roughly one
 * anonymous request in flight (measured: 3 concurrent gave two 429s, 6 gave
 * five), so parallelising earns rate-limit errors rather than throughput. What
 * makes a long run finish is `generateProductImage`'s retry — a 429 means "in a
 * moment", not "never", and treating the two the same is what previously turned
 * a batch of forty into three images and thirty-seven phantom failures.
 *
 * **Popular products are photographed first.** At roughly 40s an image the full
 * catalogue is a many-hour job, so whatever budget a run has should be spent on
 * what shoppers actually see. Every run is resumable: rows already carrying an
 * image are skipped, so this can be stopped and restarted freely.
 *
 *   npm run catalog:variant-images -- --limit 200 --category "T-Shirts"
 */
async function main() {
  const { db } = await import("@/db");
  const { productVariants } = await import("@/db/schema");
  const { sql } = await import("drizzle-orm");
  const { buildImagePrompt, generateProductImage, seedFor } = await import("@/server/ai/images");
  const { storage } = await import("@/server/storage");

  const args = process.argv.slice(2);
  const readArg = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const limit = Number(readArg("--limit") ?? 120);
  const category = readArg("--category");
  const gender = readArg("--gender");
  const force = args.includes("--force");

  // One row per (product, colour): the cheapest variant of each colour stands
  // in for the rest, and its image is copied to its siblings afterwards.
  // Ordered by units sold so a partial run leaves the catalogue's most-seen
  // products photographed rather than an arbitrary alphabetical slice.
  const rows = (await db.execute(sql`
    WITH sold AS (
      SELECT v.product_id, SUM(oi.quantity) AS units
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN product_variants v ON v.id = oi.variant_id
      WHERE o.state IN ('paid','fulfilled')
      GROUP BY v.product_id
    ),
    pairs AS (
      SELECT DISTINCT ON (v.product_id, v.attributes->>'color')
             v.id, v.attributes->>'color' AS color,
             p.id AS product_id, p.title, p.category, p.brand, p.attributes,
             m.slug AS merchant_slug,
             COALESCE(s.units, 0) AS units
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
      JOIN merchants m ON m.id = p.merchant_id
      LEFT JOIN sold s ON s.product_id = p.id
      WHERE p.status = 'active' AND v.active
        AND v.attributes->>'color' IS NOT NULL
        AND (${force} OR v.image_url IS NULL)
        ${category ? sql`AND p.category = ${category}` : sql``}
        ${gender ? sql`AND (p.attributes->>'gender') ILIKE ${`%${gender}%`}` : sql``}
      ORDER BY v.product_id, v.attributes->>'color', v.price_minor ASC
    )
    SELECT * FROM pairs
    ORDER BY units DESC, title ASC
    LIMIT ${limit}
  `)) as unknown as {
    id: string; color: string; product_id: string; title: string;
    category: string; brand: string | null; attributes: Record<string, unknown>;
    merchant_slug: string; units: number;
  }[];

  const [remaining] = (await db.execute(sql`
    SELECT COUNT(*) AS n FROM (
      SELECT DISTINCT v.product_id, v.attributes->>'color'
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
      WHERE p.status = 'active' AND v.active
        AND v.attributes->>'color' IS NOT NULL AND v.image_url IS NULL
    ) t
  `)) as unknown as { n: string }[];

  console.log(
    `${rows.length} product-colour pairs this run (${remaining.n} still unphotographed overall)`,
  );
  console.log(`serial by design — the service rate-limits concurrent requests\n`);

  let done = 0;
  let failed = 0;
  let retries = 0;
  const startedAt = Date.now();

  for (const [index, row] of rows.entries()) {
    const prompt = buildImagePrompt({
      title: row.title,
      category: row.category,
      brand: row.brand,
      color: row.color,
      attributes: row.attributes ?? {},
    });

    const label = `${row.title.slice(0, 34).padEnd(36)} ${row.color.padEnd(10)}`;

    try {
      // Seeded on the PRODUCT, not the variant: same garment, different colour.
      // `seedFor` is shared with the product-level script rather than
      // reimplemented, so both produce the same seed for the same id.
      const image = await generateProductImage(prompt, seedFor(row.product_id), {
        onRetry: (info) => {
          retries++;
          console.log(
            `    … ${label} ${info.reason}; retry ${info.attempt}/${info.of} in ${(info.waitMs / 1000).toFixed(1)}s`,
          );
        },
      });

      const ext = image.contentType === "image/png" ? "png" : "jpg";
      const key = `products/${row.merchant_slug}/${row.product_id}-${slug(row.color)}.${ext}`;
      const stored = await storage().put(key, image.bytes, image.contentType);

      // Share it across every size of this colour.
      const updated = await db
        .update(productVariants)
        .set({ imageUrl: stored.url })
        .where(
          sql`${productVariants.productId} = ${row.product_id}
              AND ${productVariants.attributes}->>'color' = ${row.color}`,
        )
        .returning({ id: productVariants.id });

      done++;
      const rate = (Date.now() - startedAt) / 1000 / done;
      console.log(
        `  ✓ [${String(index + 1).padStart(3)}/${rows.length}] ${label}` +
          `${(image.bytes.length / 1024).toFixed(0)}KB → ${updated.length} variants` +
          `  ~${((rows.length - index - 1) * rate / 60).toFixed(0)}m left`,
      );
    } catch (error) {
      failed++;
      console.log(`  ✗ [${String(index + 1).padStart(3)}/${rows.length}] ${label}${(error as Error).message.slice(0, 44)}`);
    }
  }

  const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`\ndone — ${done} photographed, ${failed} failed, ${retries} retries, ${mins}m`);
  if (failed > 0) {
    // Nothing is lost: the next run picks up exactly the rows still NULL.
    console.log(`re-run to retry the ${failed} that failed — already-photographed rows are skipped`);
  }
  process.exit(0);
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
