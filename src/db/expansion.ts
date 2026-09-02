import { hash } from "bcryptjs";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import type { MerchantSeed, ProductTemplate } from "./seed-data";

/**
 * Additive marketplace expansion, shared by every expansion seeder.
 *
 * Deliberately does NOT truncate: `db:seed` wipes every table, which would
 * delete real accounts and their order history. Everything here is idempotent —
 * existing merchants and products are skipped, so it is safe to re-run.
 *
 * This lives apart from any one seeder because there is now more than one
 * (`seed-extra`, `seed-shoes`) and a second copy of 200 lines of insert logic
 * is exactly the drift this codebase has been bitten by before.
 */

const DEMO_PASSWORD = "demo1234";
const GST_BP = 1800;

export type ExpansionInput = {
  db: PostgresJsDatabase<typeof schema>;
  merchants: MerchantSeed[];
  products: ProductTemplate[];
  /** Order-number prefix, so each expansion's history is identifiable. */
  orderPrefix: string;
  /** Deterministic RNG seed — same input, same catalogue. */
  randomSeed: number;
  historyDays: number;
};

export type ExpansionResult = {
  merchantsAdded: number;
  productsAdded: number;
  variantsAdded: number;
  ordersAdded: number;
};

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

function variantCombos(template: ProductTemplate): Record<string, string>[] {
  return template.axes.reduce<Record<string, string>[]>(
    (acc, axis) => acc.flatMap((combo) => axis.values.map((v) => ({ ...combo, [axis.name]: v }))),
    [{}],
  );
}

/**
 * Builds a SKU, disambiguating against everything already reserved.
 *
 * The body is truncated to 10 characters and each option to 4, so distinct
 * products collide readily — `field-strike-fg` and `field-strike-sg` both
 * become `FIELDSTRIK`. Without the reserved set that is a `variants_sku_idx`
 * unique violation part-way through a seed, leaving a half-written product.
 */
function skuFor(
  merchantSlug: string,
  key: string,
  combo: Record<string, string>,
  reserved: Set<string>,
) {
  const prefix = merchantSlug.split("-")[0].toUpperCase().slice(0, 3);
  const body = key.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  const suffix = Object.values(combo)
    .map((v) => v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4))
    .join("-");
  const base = suffix ? `${prefix}-${body}-${suffix}` : `${prefix}-${body}`;

  let candidate = base;
  for (let n = 2; reserved.has(candidate); n++) candidate = `${base}-${n}`;
  reserved.add(candidate);
  return candidate;
}

export async function applyExpansion(input: ExpansionInput): Promise<ExpansionResult> {
  const { db, merchants: merchantSeeds, products: productTemplates } = input;
  const rand = mulberry32(input.randomSeed);
  const randInt = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
  const weightedPick = <T,>(items: T[], weight: (t: T) => number): T => {
    const total = items.reduce((s, i) => s + weight(i), 0);
    let r = rand() * total;
    for (const item of items) {
      r -= weight(item);
      if (r <= 0) return item;
    }
    return items[items.length - 1];
  };

  const passwordHash = await hash(DEMO_PASSWORD, 10);
  let merchantsAdded = 0;
  let productsAdded = 0;
  let variantsAdded = 0;

  // ---------------------------------------------------------------- merchants
  for (const seed of merchantSeeds) {
    const [existing] = await db
      .select({ id: schema.merchants.id })
      .from(schema.merchants)
      .where(eq(schema.merchants.slug, seed.slug))
      .limit(1);
    if (existing) continue;

    const [owner] = await db
      .insert(schema.users)
      .values({
        email: seed.supportEmail,
        name: `${seed.name} Owner`,
        role: "merchant",
        passwordHash,
      })
      .onConflictDoNothing()
      .returning();

    const ownerId =
      owner?.id ??
      (
        await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.email, seed.supportEmail))
          .limit(1)
      )[0].id;

    const [merchant] = await db
      .insert(schema.merchants)
      .values({
        userId: ownerId,
        slug: seed.slug,
        name: seed.name,
        description: seed.description,
        supportEmail: seed.supportEmail,
        fulfillmentRate: seed.fulfillmentRateBp,
        avgDispatchHours: seed.avgDispatchHours,
      })
      .returning();

    await db.insert(schema.merchantPolicies).values({ merchantId: merchant.id, ...seed.policies });
    await db.insert(schema.agentPolicies).values({
      scope: "merchant",
      scopeId: merchant.id,
      limits: {
        maxPriceChangeBp: 1000,
        maxDiscountBp: 2000,
        maxRestockUnits: 200,
        allowAutoPublish: false,
        requireApprovalForAll: true,
      },
    });
    merchantsAdded++;
  }

  const allMerchants = await db.select().from(schema.merchants);
  const bySlug = new Map(allMerchants.map((m) => [m.slug, m]));

  // Every SKU already in the catalogue, so a re-run cannot collide with itself
  // or with a previous expansion.
  const reservedSkus = new Set(
    (await db.select({ sku: schema.productVariants.sku }).from(schema.productVariants)).map(
      (v) => v.sku,
    ),
  );

  // ----------------------------------------------------------------- products
  type VariantRef = {
    variantId: string;
    merchantId: string;
    merchantSlug: string;
    priceMinor: number;
    demand: number;
    templateKey: string;
  };
  const newVariants: VariantRef[] = [];

  for (const template of productTemplates) {
    for (const slug of template.merchants) {
      const merchant = bySlug.get(slug);
      if (!merchant) continue;

      const [duplicate] = await db
        .select({ id: schema.products.id })
        .from(schema.products)
        .where(
          and(eq(schema.products.merchantId, merchant.id), eq(schema.products.title, template.title)),
        )
        .limit(1);
      if (duplicate) continue;

      const priceIndex = merchantSeeds.find((m) => m.slug === slug)?.priceIndex ?? 1;

      const [product] = await db
        .insert(schema.products)
        .values({
          merchantId: merchant.id,
          title: template.title,
          description: template.description,
          brand: template.brand,
          category: template.category,
          attributes: template.attributes,
          imageUrls: [],
          status: "active",
          ratingBp: randInt(390, 490) * 10,
          ratingCount: randInt(18, 640),
        })
        .returning();
      productsAdded++;

      const basePrice = Math.round((template.basePriceMinor * priceIndex) / 100) * 100;

      const inserted = await db
        .insert(schema.productVariants)
        .values(
          variantCombos(template).map((combo) => ({
            productId: product.id,
            sku: skuFor(slug, template.key, combo, reservedSkus),
            attributes: combo,
            priceMinor: basePrice,
            compareAtPriceMinor: rand() < 0.25 ? Math.round((basePrice * 1.18) / 100) * 100 : null,
            currency: "INR",
            active: true,
          })),
        )
        .returning();
      variantsAdded += inserted.length;

      await db.insert(schema.inventory).values(
        inserted.map((v) => ({
          variantId: v.id,
          quantity: randInt(0, 9) === 0 ? 0 : randInt(6, 70),
          reserved: 0,
          lowStockThreshold: 5,
        })),
      );

      for (const v of inserted) {
        newVariants.push({
          variantId: v.id,
          merchantId: merchant.id,
          merchantSlug: slug,
          priceMinor: v.priceMinor,
          demand: template.demand,
          templateKey: template.key,
        });
      }
    }
  }

  // ------------------------------------------------- order history for realism
  let ordersAdded = 0;
  if (newVariants.length > 0) {
    const customers = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.role, "customer"));

    if (customers.length > 0) {
      const skuByVariant = new Map(
        (await db.select().from(schema.productVariants)).map((v) => [v.id, v.sku]),
      );
      const titleByVariant = new Map(
        productTemplates.flatMap((t) => t.merchants.map((m) => [`${m}:${t.key}`, t.title] as const)),
      );
      const policyBySlug = new Map(merchantSeeds.map((m) => [m.slug, m.policies]));

      const now = new Date();
      let counter = 0;

      for (let d = input.historyDays - 1; d >= 0; d--) {
        const day = new Date(now);
        day.setDate(day.getDate() - d);
        const weekend = day.getDay() === 0 || day.getDay() === 6 ? 1.4 : 1;
        const count = Math.max(1, Math.round((2 + rand() * 4) * weekend));

        for (let o = 0; o < count; o++) {
          const anchor = weightedPick(newVariants, (v) => v.demand);
          const qty = rand() < 0.85 ? 1 : 2;
          const subtotal = anchor.priceMinor * qty;
          const policy = policyBySlug.get(anchor.merchantSlug);
          const shipping =
            policy && policy.freeShippingAboveMinor !== null && subtotal >= policy.freeShippingAboveMinor
              ? 0
              : (policy?.flatShippingMinor ?? 0);
          const tax = Math.round((subtotal * GST_BP) / 10_000);
          const total = subtotal + shipping + tax;

          const roll = rand();
          const state =
            roll < 0.87 ? "fulfilled" : roll < 0.94 ? "paid" : roll < 0.97 ? "canceled" : "payment_failed";
          const createdAt = new Date(day);
          createdAt.setHours(randInt(8, 22), randInt(0, 59), randInt(0, 59), 0);

          const [order] = await db
            .insert(schema.orders)
            .values({
              orderNumber: `${input.orderPrefix}-${createdAt.toISOString().slice(0, 10).replace(/-/g, "")}-${String(++counter).padStart(4, "0")}`,
              userId: pick(customers).id,
              merchantId: anchor.merchantId,
              state: state as (typeof schema.orderState.enumValues)[number],
              totals: {
                subtotalMinor: subtotal,
                discountMinor: 0,
                shippingMinor: shipping,
                taxMinor: tax,
                totalMinor: total,
                currency: "INR",
              },
              placedByAgent: rand() < 0.38 ? "shopping-agent/1.0" : null,
              createdAt,
              updatedAt: createdAt,
            })
            .returning();

          await db.insert(schema.orderItems).values({
            orderId: order.id,
            variantId: anchor.variantId,
            titleSnapshot: titleByVariant.get(`${anchor.merchantSlug}:${anchor.templateKey}`) ?? "Item",
            skuSnapshot: skuByVariant.get(anchor.variantId) ?? "UNKNOWN",
            attributesSnapshot: {},
            quantity: qty,
            unitPriceMinor: anchor.priceMinor,
          });
          ordersAdded++;
        }
      }
    }
  }

  return { merchantsAdded, productsAdded, variantsAdded, ordersAdded };
}
