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
 *   npm run catalog:variant-images -- --limit 200 --category "T-Shirts"
 */
async function main() {
  const { db } = await import("@/db");
  const { productVariants } = await import("@/db/schema");
  const { sql } = await import("drizzle-orm");
  const { buildImagePrompt, generateProductImage } = await import("@/server/ai/images");
  const { storage } = await import("@/server/storage");

  const args = process.argv.slice(2);
  const readArg = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const limit = Number(readArg("--limit") ?? 120);
  const category = readArg("--category");
  const force = args.includes("--force");

  // One row per (product, colour): the cheapest variant of each colour stands
  // in for the rest, and its image is copied to its siblings afterwards.
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (v.product_id, v.attributes->>'color')
           v.id, v.attributes->>'color' AS color,
           p.id AS product_id, p.title, p.category, p.brand, p.attributes,
           m.slug AS merchant_slug
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    JOIN merchants m ON m.id = p.merchant_id
    WHERE p.status = 'active' AND v.active
      AND v.attributes->>'color' IS NOT NULL
      AND (${force} OR v.image_url IS NULL)
      ${category ? sql`AND p.category = ${category}` : sql``}
    ORDER BY v.product_id, v.attributes->>'color', v.price_minor ASC
    LIMIT ${limit}
  `)) as unknown as {
    id: string; color: string; product_id: string; title: string;
    category: string; brand: string | null; attributes: Record<string, unknown>;
    merchant_slug: string;
  }[];

  console.log(`${rows.length} product-colour pairs to photograph\n`);

  let done = 0;
  let failed = 0;

  for (const row of rows) {
    const prompt = buildImagePrompt({
      title: row.title,
      category: row.category,
      brand: row.brand,
      color: row.color,
      attributes: row.attributes ?? {},
    });

    try {
      // Seeded on the PRODUCT, not the variant: same garment, different colour.
      const image = await generateProductImage(prompt, hash(row.product_id));
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
      console.log(
        `  ✓ ${row.title.slice(0, 38).padEnd(40)} ${row.color.padEnd(10)} ` +
          `${(image.bytes.length / 1024).toFixed(0)}KB → ${updated.length} variants`,
      );
    } catch (error) {
      failed++;
      console.log(`  ✗ ${row.title.slice(0, 38).padEnd(40)} ${row.color.padEnd(10)} ${(error as Error).message.slice(0, 50)}`);
    }
  }

  console.log(`\ndone — ${done} colours photographed, ${failed} failed`);
  process.exit(0);
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Stable numeric seed from an id, so a re-run reproduces the same image. */
function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  return Math.abs(h);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
