import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";

/**
 * Shoppers who behave like people.
 *
 * The seed dealt orders out with `pick(customers)` — uniformly at random — so
 * the average "repeat shopper" ended up with 62 purchases spread across 25 of
 * the 57 categories. That is not a person, it is a sample of the catalogue, and
 * it makes the whole idea of a taste profile unmeasurable: `npm run eval:for-you`
 * showed the profile losing to plain popularity, and no algorithm can predict a
 * uniform sample. The data had no signal to find.
 *
 * A persona fixes that at the source. Each shopper gets a few categories they
 * actually shop, brands they return to, and a price band they stay within —
 * then most of their orders are drawn from it.
 *
 * **Most, not all.** `EXPLORE_RATE` of purchases deliberately fall outside the
 * persona, because a shopper who NEVER strays is as unrealistic as one who
 * never repeats, and a profile that only ever has to predict perfect
 * consistency would score well while learning nothing. The exploration is what
 * makes the task hard enough to be worth measuring.
 *
 * Additive and idempotent, like `seed-extra`. It creates its own accounts and
 * never touches existing orders — reviews cascade from orders, and deleting
 * 861 of them once was enough (§6).
 */

export type Persona = {
  key: string;
  name: string;
  /** What they actually shop for, most-preferred first. */
  categories: string[];
  /** Roughly what they are willing to spend on one item, in rupees. */
  budget: { min: number; max: number };
};

/**
 * Ten personas over the real category vocabulary.
 *
 * Deliberately overlapping — two runners who differ on price, a hiker and a
 * commuter who share Outerwear — because personas that partition the catalogue
 * cleanly would make the prediction task trivial and the eval flattering.
 */
export const PERSONAS: Persona[] = [
  { key: "road-runner", name: "Road runner",
    categories: ["Running Shoes", "Activewear", "Socks", "Base Layers"], budget: { min: 1200, max: 9000 } },
  { key: "trail-hiker", name: "Trail hiker",
    categories: ["Trail Shoes", "Hiking Boots", "Outdoor Gear", "Backpacks", "Jackets"], budget: { min: 2000, max: 18000 } },
  { key: "office-smart", name: "Office professional",
    categories: ["Formal Shoes", "Shirts", "Trousers", "Suits", "Belts"], budget: { min: 1500, max: 14000 } },
  { key: "gym-regular", name: "Gym regular",
    categories: ["Training Shoes", "Activewear", "Base Layers", "Fitness Accessories"], budget: { min: 900, max: 7000 } },
  { key: "casual-everyday", name: "Everyday casual",
    categories: ["Sneakers", "T-Shirts", "Hoodies", "Jeans"], budget: { min: 700, max: 6000 } },
  { key: "home-cook", name: "Home cook",
    categories: ["Kitchen Knives", "Cookware", "Drinkware", "Small Appliances"], budget: { min: 800, max: 12000 } },
  { key: "commuter", name: "City commuter",
    categories: ["Walking Shoes", "Backpacks", "Outerwear", "Drinkware"], budget: { min: 900, max: 9000 } },
  { key: "home-comfort", name: "Home comfort",
    categories: ["Bedding", "Towels", "Home Textiles", "Lighting"], budget: { min: 900, max: 11000 } },
  { key: "tech-forward", name: "Tech-forward",
    categories: ["Headphones", "Audio", "Chargers", "Wearables"], budget: { min: 1500, max: 22000 } },
  { key: "court-sports", name: "Court sports",
    categories: ["Court Shoes", "Basketball Shoes", "Activewear", "Socks"], budget: { min: 1500, max: 12000 } },
];

/** How often a shopper buys outside their persona. */
const EXPLORE_RATE = 0.2;

const GST_BP = 1800;

/** Deterministic RNG, so a re-run reproduces the same shoppers exactly. */
function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
}

type Buyable = {
  variantId: string;
  productId: string;
  sku: string;
  title: string;
  category: string;
  brand: string | null;
  merchantId: string;
  priceMinor: number;
  attributes: Record<string, string>;
};

export type PersonaSeedResult = {
  shoppersCreated: number;
  shoppersExisting: number;
  ordersAdded: number;
  personasUsed: number;
};

async function loadBuyables(): Promise<Buyable[]> {
  const rows = (await db.execute(sql`
    SELECT v.id AS variant_id, v.sku, v.price_minor, v.attributes,
           p.id AS product_id, p.title, p.category, p.brand, p.merchant_id
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    JOIN merchants m ON m.id = p.merchant_id
    WHERE v.active = true AND p.status = 'active' AND m.status = 'active'
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    variantId: String(r.variant_id),
    productId: String(r.product_id),
    sku: String(r.sku),
    title: String(r.title),
    category: String(r.category),
    brand: r.brand ? String(r.brand) : null,
    merchantId: String(r.merchant_id),
    priceMinor: Number(r.price_minor),
    attributes: (r.attributes as Record<string, string>) ?? {},
  }));
}

/**
 * Seeds persona shoppers and a coherent order history for each.
 *
 * `shoppersPerPersona` small on purpose: the point is shoppers with ENOUGH
 * history each to have a recognisable taste, not a large population of
 * one-purchase accounts that teach a profile nothing.
 */
export async function seedPersonaShoppers(options: {
  shoppersPerPersona?: number;
  ordersPerShopper?: { min: number; max: number };
  historyDays?: number;
} = {}): Promise<PersonaSeedResult> {
  const perPersona = options.shoppersPerPersona ?? 3;
  const orderRange = options.ordersPerShopper ?? { min: 8, max: 22 };
  const historyDays = options.historyDays ?? 300;

  const buyables = await loadBuyables();
  if (buyables.length === 0) {
    return { shoppersCreated: 0, shoppersExisting: 0, ordersAdded: 0, personasUsed: 0 };
  }

  const byCategory = new Map<string, Buyable[]>();
  for (const b of buyables) {
    const bucket = byCategory.get(b.category) ?? [];
    bucket.push(b);
    byCategory.set(b.category, bucket);
  }

  let created = 0;
  let existing = 0;
  let ordersAdded = 0;
  let personasUsed = 0;

  for (const persona of PERSONAS) {
    // A persona whose categories this catalogue does not stock is skipped
    // rather than silently producing a shopper who buys at random — which is
    // the exact failure being fixed.
    const inPersona = persona.categories.flatMap((c) => byCategory.get(c) ?? []);
    if (inPersona.length < 4) continue;
    personasUsed++;

    for (let i = 0; i < perPersona; i++) {
      const email = `${persona.key}-${i + 1}@personas.test`;
      const rand = rng(email);

      const [already] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1);

      if (already) {
        existing++;
        // Idempotent: a shopper who already has their history is left alone,
        // so this can be re-run without doubling anybody's orders.
        const [{ n }] = (await db.execute(sql`
          SELECT COUNT(*)::int AS n FROM orders WHERE user_id = ${already.id}
        `)) as unknown as { n: number }[];
        if (n > 0) continue;
      }

      const userId =
        already?.id ??
        (
          await db
            .insert(schema.users)
            .values({
              email,
              name: `${persona.name} ${i + 1}`,
              role: "customer",
              passwordHash: null,
            })
            .returning()
        )[0].id;
      if (!already) created++;

      /*
       * A brand this shopper keeps returning to.
       *
       * Category alone is a weak persona — everyone buying Running Shoes looks
       * alike. Brand loyalty is what makes one runner distinguishable from
       * another, and it is what `affinityFor` scores most heavily.
       */
      const brands = [...new Set(inPersona.map((b) => b.brand).filter(Boolean))] as string[];
      const favourite = brands.length > 0 ? brands[Math.floor(rand() * brands.length)] : null;

      const affordable = inPersona.filter(
        (b) => b.priceMinor >= persona.budget.min * 100 && b.priceMinor <= persona.budget.max * 100,
      );
      const pool = affordable.length >= 4 ? affordable : inPersona;

      const orderCount =
        orderRange.min + Math.floor(rand() * (orderRange.max - orderRange.min + 1));

      for (let o = 0; o < orderCount; o++) {
        const exploring = rand() < EXPLORE_RATE;
        const candidates = exploring ? buyables : pool;

        // Within the persona, the favourite brand wins most of the time —
        // enough to be a pattern, not so much that it is the only pattern.
        const preferred =
          !exploring && favourite && rand() < 0.55
            ? candidates.filter((b) => b.brand === favourite)
            : candidates;
        const from = preferred.length > 0 ? preferred : candidates;
        const item = from[Math.floor(rand() * from.length)];

        const daysAgo = Math.floor(rand() * historyDays);
        const createdAt = new Date();
        createdAt.setDate(createdAt.getDate() - daysAgo);
        createdAt.setHours(9 + Math.floor(rand() * 12), Math.floor(rand() * 60), 0, 0);

        const quantity = rand() < 0.88 ? 1 : 2;
        const subtotal = item.priceMinor * quantity;
        const tax = Math.round((subtotal * GST_BP) / 10_000);
        const total = subtotal + tax;

        const [order] = await db
          .insert(schema.orders)
          .values({
            orderNumber: `PER-${createdAt.toISOString().slice(0, 10).replace(/-/g, "")}-${userId.slice(0, 4)}-${o}`,
            userId,
            merchantId: item.merchantId,
            // Fulfilled, mostly: a persona is about what they CHOSE, and a
            // failed payment says nothing about taste.
            state: rand() < 0.92 ? "fulfilled" : "paid",
            totals: {
              subtotalMinor: subtotal,
              discountMinor: 0,
              shippingMinor: 0,
              taxMinor: tax,
              totalMinor: total,
              currency: "INR",
            },
            placedByAgent: rand() < 0.3 ? "shopping-agent/1.0" : null,
            createdAt,
            updatedAt: createdAt,
          })
          .returning();

        await db.insert(schema.orderItems).values({
          orderId: order.id,
          variantId: item.variantId,
          titleSnapshot: item.title,
          skuSnapshot: item.sku,
          attributesSnapshot: item.attributes,
          quantity,
          unitPriceMinor: item.priceMinor,
        });
        ordersAdded++;
      }
    }
  }

  return { shoppersCreated: created, shoppersExisting: existing, ordersAdded, personasUsed };
}

/** Removes the persona cohort entirely, for a clean re-seed. */
export async function clearPersonaShoppers(): Promise<number> {
  const users = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`${schema.users.email} LIKE '%@personas.test'`);
  if (users.length === 0) return 0;

  const ids = users.map((u) => u.id);
  await db.delete(schema.orders).where(inArray(schema.orders.userId, ids));
  await db
    .delete(schema.users)
    .where(and(inArray(schema.users.id, ids), eq(schema.users.role, "customer")));
  return ids.length;
}
