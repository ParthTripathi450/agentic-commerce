import { hash } from "bcryptjs";
import { config as loadEnv } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import * as schema from "./schema";
import { writeReview } from "./review-writer";
import type { QualityScores } from "./catalog-blueprints";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Reviews, and the purchase history the schema requires for them.
 *
 * `product_reviews.order_id` is NOT NULL with a unique index on
 * (order_id, variant_id): verified purchase is enforced in the SCHEMA, not just
 * the action. That is a property worth keeping, so this seeder generates real
 * orders rather than weakening the constraint.
 *
 * Coverage is deliberately even rather than demand-weighted. Popularity follows
 * a power law, so weighting by demand would leave most of the catalogue with no
 * reviews at all — and a product with no evidence is invisible to retrieval,
 * which is the opposite of what this dataset is for.
 */

/** Names for the reviewer pool, so the corpus does not read as one voice. */
const REVIEWER_NAMES = [
  "Aditi R.", "Rohan M.", "Priya S.", "Karan B.", "Meera N.", "Vikram T.",
  "Ananya G.", "Dev P.", "Sneha K.", "Arun V.", "Nisha D.", "Farhan A.",
  "Ishita C.", "Manav J.", "Tara L.", "Yusuf H.", "Kavya R.", "Nikhil S.",
  "Ritu B.", "Sameer Q.",
];

const TARGET_REVIEWS_PER_PRODUCT = { min: 4, max: 12 };
const GST_BP = 1800;

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type ProductRow = {
  id: string;
  title: string;
  category: string;
  merchant_id: string;
  attributes: Record<string, unknown>;
};

type VariantRow = { id: string; product_id: string; price_minor: number; sku: string; attributes: Record<string, string> };

async function main() {
  const sqlClient = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(sqlClient, { schema });
  const rand = mulberry32(20260903);
  const randInt = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

  const products = (await db.execute(sql`
    SELECT id, title, category, merchant_id, attributes FROM products WHERE status = 'active'
  `)) as unknown as ProductRow[];

  const variants = (await db.execute(sql`
    SELECT id, product_id, price_minor, sku, attributes FROM product_variants WHERE active = true
  `)) as unknown as VariantRow[];

  /*
   * Reviews are authored by a DEDICATED pool, never by test accounts.
   *
   * `provisionTestShopper()` deletes every order belonging to its user and
   * reviews cascade from orders, so attributing the corpus to a test shopper
   * means `npm test` silently destroys part of the dataset. It already did:
   * 861 reviews vanished on the first suite run, leaving their embedded chunks
   * orphaned and pointing at rows that no longer existed.
   *
   * The handful of genuine shopper accounts are too few to plausibly author
   * four thousand reviews, so this provisions its own reviewers on a domain
   * nothing else touches.
   */
  const REVIEWER_COUNT = 60;
  const reviewerHash = await hash("demo1234", 10);

  await db
    .insert(schema.users)
    .values(
      Array.from({ length: REVIEWER_COUNT }, (_, i) => ({
        email: `reviewer-${String(i + 1).padStart(3, "0")}@marketplace.reviews`,
        name: REVIEWER_NAMES[i % REVIEWER_NAMES.length],
        role: "customer" as const,
        passwordHash: reviewerHash,
      })),
    )
    .onConflictDoNothing();

  const customers = (await db.execute(sql`
    SELECT id FROM users WHERE email LIKE '%@marketplace.reviews'
  `)) as unknown as { id: string }[];

  if (customers.length === 0) throw new Error("no customers to attribute reviews to");

  const variantsByProduct = new Map<string, VariantRow[]>();
  for (const v of variants) {
    const list = variantsByProduct.get(v.product_id) ?? [];
    list.push(v);
    variantsByProduct.set(v.product_id, list);
  }

  // Lines already reviewed, so a re-run tops up rather than duplicating.
  const existing = (await db.execute(sql`
    SELECT order_id || ':' || variant_id AS key FROM product_reviews
  `)) as unknown as { key: string }[];
  const reviewed = new Set(existing.map((r) => r.key));

  const counts = (await db.execute(sql`
    SELECT product_id, count(*)::int AS n FROM product_reviews GROUP BY product_id
  `)) as unknown as { product_id: string; n: number }[];
  const existingByProduct = new Map(counts.map((c) => [c.product_id, Number(c.n)]));

  // Unique per run: the counter restarts each time, so without this a re-run
  // collides with order numbers a previous run already inserted.
  const runToken = Date.now().toString(36).toUpperCase().slice(-6);
  let ordersAdded = 0;
  let reviewsAdded = 0;
  const now = new Date();

  for (const product of products) {
    const productVariants = variantsByProduct.get(product.id);
    if (!productVariants?.length) continue;

    const qualities = (product.attributes?.qualities ?? {}) as QualityScores;
    const target = randInt(TARGET_REVIEWS_PER_PRODUCT.min, TARGET_REVIEWS_PER_PRODUCT.max);

    // Top up to the target rather than always adding more, so a re-run repairs
    // the corpus instead of inflating it.
    const already = existingByProduct.get(product.id) ?? 0;
    const wanted = Math.max(0, target - already);

    for (let i = 0; i < wanted; i++) {
      const variant = productVariants[Math.floor(rand() * productVariants.length)];
      const customer = customers[Math.floor(rand() * customers.length)];
      const quantity = rand() < 0.85 ? 1 : 2;
      const subtotal = Number(variant.price_minor) * quantity;
      const tax = Math.round((subtotal * GST_BP) / 10_000);
      const total = subtotal + tax;

      const daysAgo = randInt(3, 300);
      const createdAt = new Date(now);
      createdAt.setDate(createdAt.getDate() - daysAgo);
      createdAt.setHours(randInt(8, 22), randInt(0, 59), randInt(0, 59), 0);

      const [order] = await db
        .insert(schema.orders)
        .values({
          orderNumber: `ACR-${runToken}-${(++ordersAdded).toString().padStart(5, "0")}`,
          userId: customer.id,
          merchantId: product.merchant_id,
          // Reviews require a completed purchase, so this history is fulfilled.
          state: "fulfilled",
          totals: {
            subtotalMinor: subtotal, discountMinor: 0, shippingMinor: 0,
            taxMinor: tax, totalMinor: total, currency: "INR",
          },
          placedByAgent: rand() < 0.3 ? "shopping-agent/1.0" : null,
          createdAt,
          updatedAt: createdAt,
        })
        .returning();

      await db.insert(schema.orderItems).values({
        orderId: order.id,
        variantId: variant.id,
        titleSnapshot: product.title,
        skuSnapshot: variant.sku,
        attributesSnapshot: variant.attributes ?? {},
        quantity,
        unitPriceMinor: Number(variant.price_minor),
      });

      const key = `${order.id}:${variant.id}`;
      if (reviewed.has(key)) continue;

      const draft = writeReview({
        productTitle: product.title,
        category: product.category,
        qualities,
        rand,
      });

      // Reviews land a few days after the order, never before it.
      const reviewedAt = new Date(createdAt);
      reviewedAt.setDate(reviewedAt.getDate() + randInt(2, 21));
      if (reviewedAt > now) reviewedAt.setTime(now.getTime());

      await db.insert(schema.productReviews).values({
        productId: product.id,
        variantId: variant.id,
        merchantId: product.merchant_id,
        userId: customer.id,
        orderId: order.id,
        ratingBp: draft.ratingBp,
        title: draft.title,
        body: draft.body,
        createdAt: reviewedAt,
        updatedAt: reviewedAt,
      });
      reviewed.add(key);
      reviewsAdded++;
    }
  }

  // Product rating aggregates are denormalised on `products`; recompute them so
  // the ranker's Bayesian shrinkage sees the reviews that now exist.
  await db.execute(sql`
    UPDATE products p
    SET rating_bp = agg.avg_bp, rating_count = agg.n, updated_at = now()
    FROM (
      SELECT product_id, ROUND(AVG(rating_bp))::int AS avg_bp, COUNT(*)::int AS n
      FROM product_reviews GROUP BY product_id
    ) agg
    WHERE agg.product_id = p.id
  `);

  const [{ count: reviewCount }] = await sqlClient<{ count: string }[]>`SELECT count(*) FROM product_reviews`;
  const [{ count: covered }] = await sqlClient<{ count: string }[]>`
    SELECT count(DISTINCT product_id) FROM product_reviews`;

  console.log(`
added:
  orders     ${ordersAdded}
  reviews    ${reviewsAdded}

corpus now:
  reviews          ${reviewCount}
  products covered ${covered} / ${products.length}

next: npm run catalog:index
`);
  await sqlClient.end();
}

main().catch((error) => { console.error(error); process.exit(1); });
