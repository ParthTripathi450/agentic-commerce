import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Repairs review headlines that argue with their own body.
 *
 * `titleFor` used to take its sentiment from the reviewer's OVERALL star
 * rating while the body took its sentiment from each quality's own score. Those
 * disagree exactly when a product is good at one thing and bad overall — a shoe
 * scoring breathability 4 and durability 1 rates ~2.5 stars, and was titled
 * "Breathability is the weak spot" above a body correctly praising the airflow.
 *
 * That is corpus poisoning, and it matters more here than anywhere else: the
 * dataset's entire value is that prose, attributes and opinion agree, and
 * retrieval over a self-contradicting corpus learns the false association with
 * nothing downstream able to see it. It also fails visibly now that the review
 * text is quoted to shoppers.
 *
 * Surgical on purpose. Regenerating the reviews would rewrite 4,008 bodies and
 * every rating with them; this rewrites only the headline, only where it
 * disagrees with the score it names, and leaves everything else untouched.
 *
 *   npm run db:fix-review-titles [-- --dry-run]
 */
async function main() {
  const { db } = await import("@/db");
  const { productReviews } = await import("@/db/schema");
  const { sql, eq } = await import("drizzle-orm");
  const { QUALITY_LABELS } = await import("./catalog-blueprints");

  const dryRun = process.argv.includes("--dry-run");

  // Longest label first: "material quality" must match before "quality" would.
  const byLabel = (Object.entries(QUALITY_LABELS) as [string, string][])
    .sort((a, b) => b[1].length - a[1].length);

  const rows = (await db.execute(sql`
    SELECT r.id, r.title, r.body, r.rating_bp,
           p.attributes->'qualities' AS qualities, p.title AS product_title
    FROM product_reviews r
    JOIN products p ON p.id = r.product_id
    WHERE r.title IS NOT NULL AND p.attributes ? 'qualities'
  `)) as unknown as {
    id: string; title: string; body: string | null; rating_bp: number;
    qualities: Record<string, number>; product_title: string;
  }[];

  let checked = 0;
  let fixed = 0;
  const samples: string[] = [];

  for (const row of rows) {
    const title = row.title;
    const lower = title.toLowerCase();

    const match = byLabel.find(([, label]) => lower.includes(label.toLowerCase()));
    if (!match) continue;
    const [key, label] = match;

    const score = row.qualities?.[key];
    if (score === undefined) continue;
    checked++;

    // Which way does the existing headline lean, and which way should it?
    const readsPositive = /great |selling point|nails /i.test(title);
    const shouldBePositive = score >= 4;
    if (readsPositive === shouldBePositive) continue;

    const corrected = shouldBePositive
      ? `The ${label} is the selling point`
      : `${label.charAt(0).toUpperCase()}${label.slice(1)} is the weak spot`;

    if (samples.length < 6) {
      samples.push(
        `  ${row.product_title.slice(0, 30).padEnd(32)} ${key}=${score}\n` +
          `     was: "${title}"\n     now: "${corrected}"\n` +
          `     body: "${(row.body ?? "").slice(0, 90)}"`,
      );
    }

    if (!dryRun) {
      await db.update(productReviews).set({ title: corrected }).where(eq(productReviews.id, row.id));
    }
    fixed++;
  }

  console.log(`${rows.length} reviews, ${checked} name a quality, ${fixed} contradicted it\n`);
  for (const sample of samples) console.log(sample + "\n");
  console.log(
    dryRun
      ? "dry run — nothing written"
      : `rewrote ${fixed} headlines. Re-run \`npm run catalog:index\` to re-embed the evidence.`,
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
