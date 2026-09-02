import { hash } from "bcryptjs";
import { config as loadEnv } from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { exportJWK, generateKeyPair } from "jose";
import { randomUUID } from "node:crypto";
import * as schema from "./schema";
import { MERCHANTS, PRODUCT_TEMPLATES, type ProductTemplate } from "./seed-data";
import { truncateAll } from "./reset";

loadEnv({ path: ".env.local", quiet: true });

const DEMO_PASSWORD = "demo1234";
const HISTORY_DAYS = 90;
const GST_BP = 1800; // 18% GST, applied to the discounted subtotal

/** Seeded PRNG so every run produces the identical marketplace. */
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
const rand = mulberry32(20260901);

const randInt = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

function weightedPick<T>(items: T[], weight: (t: T) => number): T {
  const total = items.reduce((s, i) => s + weight(i), 0);
  let r = rand() * total;
  for (const item of items) {
    r -= weight(item);
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

/** Cartesian product of the variant axes. */
function variantCombos(template: ProductTemplate): Record<string, string>[] {
  return template.axes.reduce<Record<string, string>[]>(
    (acc, axis) =>
      acc.flatMap((combo) => axis.values.map((v) => ({ ...combo, [axis.name]: v }))),
    [{}],
  );
}

function skuFor(merchantSlug: string, key: string, combo: Record<string, string>) {
  const prefix = merchantSlug.split("-")[0].toUpperCase().slice(0, 3);
  const body = key.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  const suffix = Object.values(combo)
    .map((v) => v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4))
    .join("-");
  return suffix ? `${prefix}-${body}-${suffix}` : `${prefix}-${body}`;
}

async function newKeyPair() {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const kid = randomUUID().slice(0, 8);
  return { kid, publicJwk: { ...publicJwk, kid, alg: "ES256" }, privateJwk: { ...privateJwk, kid, alg: "ES256" } };
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(sql, { schema });

  console.log("clearing existing data…");
  await truncateAll(sql);

  const passwordHash = await hash(DEMO_PASSWORD, 10);
  const now = new Date();

  // ------------------------------------------------------------------ users
  const [admin] = await db
    .insert(schema.users)
    .values({
      email: "admin@acp.test",
      name: "Platform Admin",
      role: "admin",
      passwordHash,
    })
    .returning();

  const customerSeeds = [
    { email: "riya@shopper.test", name: "Riya Sharma" },
    { email: "arjun@shopper.test", name: "Arjun Mehta" },
    { email: "demo@shopper.test", name: "Demo Shopper" },
  ];
  const customers = await db
    .insert(schema.users)
    .values(customerSeeds.map((c) => ({ ...c, role: "customer" as const, passwordHash })))
    .returning();

  const merchantUsers = await db
    .insert(schema.users)
    .values(
      MERCHANTS.map((m) => ({
        email: m.supportEmail,
        name: `${m.name} Owner`,
        role: "merchant" as const,
        passwordHash,
      })),
    )
    .returning();

  // -------------------------------------------------------------- merchants
  const merchantRows = await db
    .insert(schema.merchants)
    .values(
      MERCHANTS.map((m, i) => ({
        userId: merchantUsers[i].id,
        slug: m.slug,
        name: m.name,
        description: m.description,
        supportEmail: m.supportEmail,
        fulfillmentRate: m.fulfillmentRateBp,
        avgDispatchHours: m.avgDispatchHours,
      })),
    )
    .returning();

  const merchantBySlug = new Map(merchantRows.map((m) => [m.slug, m]));

  await db.insert(schema.merchantPolicies).values(
    MERCHANTS.map((m) => ({
      merchantId: merchantBySlug.get(m.slug)!.id,
      ...m.policies,
    })),
  );

  // Signing keys: platform + one per merchant + one per customer (AP2 chain).
  const keyValues: (typeof schema.signingKeys.$inferInsert)[] = [];
  const platformKey = await newKeyPair();
  keyValues.push({
    ownerType: "platform",
    ownerId: "platform",
    kid: `platform-${platformKey.kid}`,
    publicJwk: platformKey.publicJwk,
    privateJwk: platformKey.privateJwk,
  });
  for (const m of merchantRows) {
    const k = await newKeyPair();
    keyValues.push({
      ownerType: "merchant",
      ownerId: m.id,
      kid: `merchant-${k.kid}`,
      publicJwk: k.publicJwk,
      privateJwk: k.privateJwk,
    });
  }
  for (const c of [...customers, admin]) {
    const k = await newKeyPair();
    keyValues.push({
      ownerType: "user",
      ownerId: c.id,
      kid: `user-${k.kid}`,
      publicJwk: k.publicJwk,
      privateJwk: k.privateJwk,
    });
  }
  await db.insert(schema.signingKeys).values(keyValues);

  // ---------------------------------------------------------------- catalog
  type VariantRef = {
    variantId: string;
    productId: string;
    merchantId: string;
    merchantSlug: string;
    templateKey: string;
    attributes: Record<string, string>;
    priceMinor: number;
    demand: number;
  };
  const variantRefs: VariantRef[] = [];

  for (const template of PRODUCT_TEMPLATES) {
    for (const slug of template.merchants) {
      const merchant = merchantBySlug.get(slug);
      if (!merchant) continue;
      const seedConfig = MERCHANTS.find((m) => m.slug === slug)!;

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
          // Ratings vary a little per merchant so the ranker has a real signal.
          ratingBp: randInt(380, 490) * 10,
          ratingCount: randInt(12, 940),
        })
        .returning();

      const combos = variantCombos(template);
      const basePrice = Math.round(
        (template.basePriceMinor * seedConfig.priceIndex) / 100,
      ) * 100;

      const variantValues = combos.map((combo) => ({
        productId: product.id,
        sku: skuFor(slug, template.key, combo),
        attributes: combo,
        priceMinor: basePrice,
        compareAtPriceMinor: rand() < 0.3 ? Math.round((basePrice * 1.2) / 100) * 100 : null,
        currency: "INR",
        active: true,
      }));

      const insertedVariants = await db
        .insert(schema.productVariants)
        .values(variantValues)
        .returning();

      await db.insert(schema.inventory).values(
        insertedVariants.map((v) => ({
          variantId: v.id,
          quantity: randInt(0, 8) === 0 ? 0 : randInt(4, 60),
          reserved: 0,
          lowStockThreshold: 5,
        })),
      );

      for (const v of insertedVariants) {
        variantRefs.push({
          variantId: v.id,
          productId: product.id,
          merchantId: merchant.id,
          merchantSlug: slug,
          templateKey: template.key,
          attributes: v.attributes,
          priceMinor: v.priceMinor,
          demand: template.demand,
        });
      }
    }
  }

  // ------------------------------------------------------------- promotions
  await db.insert(schema.promotions).values([
    {
      merchantId: merchantBySlug.get("stride-athletics")!.id,
      code: "RUN10",
      title: "10% off running footwear",
      type: "percentage_off",
      value: 1000,
      conditions: { minSubtotalMinor: 300000, categories: ["Running Shoes"] },
      active: true,
    },
    {
      merchantId: merchantBySlug.get("budget-bazaar")!.id,
      code: "SAVE200",
      title: "Flat ₹200 off orders above ₹1,500",
      type: "flat_off",
      value: 20000,
      conditions: { minSubtotalMinor: 150000 },
      active: true,
    },
    {
      merchantId: merchantBySlug.get("voltix-electronics")!.id,
      code: "FREESHIP",
      title: "Free shipping on audio",
      type: "free_shipping",
      value: 0,
      conditions: { categories: ["Headphones", "Earbuds"] },
      active: true,
    },
  ]);

  // ---------------------------------------------------- 90 days of order history
  console.log(`generating ${HISTORY_DAYS} days of order history…`);
  const agentNames = ["shopping-agent/1.0", "mcp-desktop-client", "acp-web-agent"];
  let orderCounter = 0;
  const orderValues: (typeof schema.orders.$inferInsert)[] = [];
  const orderItemsByOrder: { orderNumber: string; items: Omit<typeof schema.orderItems.$inferInsert, "orderId">[] }[] = [];

  const templateByKey = new Map(PRODUCT_TEMPLATES.map((t) => [t.key, t]));
  const policyBySlug = new Map(MERCHANTS.map((m) => [m.slug, m.policies]));

  for (let d = HISTORY_DAYS - 1; d >= 0; d--) {
    const day = new Date(now);
    day.setDate(day.getDate() - d);
    const dow = day.getDay();
    const weekendBoost = dow === 0 || dow === 6 ? 1.45 : 1;
    const trend = 1 + (HISTORY_DAYS - d) / HISTORY_DAYS * 0.35; // gentle growth
    const ordersToday = Math.max(1, Math.round((3 + rand() * 5) * weekendBoost * trend));

    for (let o = 0; o < ordersToday; o++) {
      const anchor = weightedPick(variantRefs, (v) => v.demand);
      const merchantVariants = variantRefs.filter((v) => v.merchantId === anchor.merchantId);
      const itemCount = rand() < 0.72 ? 1 : 2;

      const chosen: VariantRef[] = [anchor];
      if (itemCount === 2 && merchantVariants.length > 1) {
        const second = weightedPick(merchantVariants, (v) => v.demand);
        if (second.variantId !== anchor.variantId) chosen.push(second);
      }

      const items = chosen.map((v) => {
        const qty = rand() < 0.85 ? 1 : 2;
        const template = templateByKey.get(v.templateKey)!;
        return {
          variantId: v.variantId,
          titleSnapshot: template.title,
          skuSnapshot: "",
          attributesSnapshot: v.attributes,
          quantity: qty,
          unitPriceMinor: v.priceMinor,
        };
      });

      const subtotal = items.reduce((s, i) => s + i.unitPriceMinor * i.quantity, 0);
      const policy = policyBySlug.get(anchor.merchantSlug)!;
      const shipping =
        policy.freeShippingAboveMinor !== null && subtotal >= policy.freeShippingAboveMinor
          ? 0
          : policy.flatShippingMinor;
      const discount = 0;
      const tax = Math.round(((subtotal - discount) * GST_BP) / 10_000);
      const total = subtotal - discount + shipping + tax;

      const roll = rand();
      const state: (typeof schema.orderState.enumValues)[number] =
        roll < 0.86 ? "fulfilled" : roll < 0.93 ? "paid" : roll < 0.97 ? "canceled" : "payment_failed";

      const byAgent = rand() < 0.35;
      const createdAt = new Date(day);
      createdAt.setHours(randInt(8, 22), randInt(0, 59), randInt(0, 59), 0);

      const orderNumber = `ACP-${createdAt.toISOString().slice(0, 10).replace(/-/g, "")}-${String(
        ++orderCounter,
      ).padStart(4, "0")}`;

      orderValues.push({
        orderNumber,
        userId: pick(customers).id,
        merchantId: anchor.merchantId,
        state,
        totals: {
          subtotalMinor: subtotal,
          discountMinor: discount,
          shippingMinor: shipping,
          taxMinor: tax,
          totalMinor: total,
          currency: "INR",
        },
        placedByAgent: byAgent ? pick(agentNames) : null,
        createdAt,
        updatedAt: createdAt,
      });
      orderItemsByOrder.push({ orderNumber, items });
    }
  }

  // Fill SKU snapshots from the variant table before insert.
  const allVariants = await db.select().from(schema.productVariants);
  const skuByVariant = new Map(allVariants.map((v) => [v.id, v.sku]));
  for (const entry of orderItemsByOrder) {
    for (const item of entry.items) {
      item.skuSnapshot = skuByVariant.get(item.variantId) ?? "UNKNOWN";
    }
  }

  const insertedOrders = await db.insert(schema.orders).values(orderValues).returning({
    id: schema.orders.id,
    orderNumber: schema.orders.orderNumber,
  });
  const orderIdByNumber = new Map(insertedOrders.map((o) => [o.orderNumber, o.id]));

  const itemRows = orderItemsByOrder.flatMap((entry) =>
    entry.items.map((item) => ({ ...item, orderId: orderIdByNumber.get(entry.orderNumber)! })),
  );
  for (let i = 0; i < itemRows.length; i += 500) {
    await db.insert(schema.orderItems).values(itemRows.slice(i, i + 500));
  }

  // Payment records for the orders that actually charged.
  const paidOrders = orderValues
    .map((o) => ({ o, id: orderIdByNumber.get(o.orderNumber)! }))
    .filter(({ o }) => o.state === "paid" || o.state === "fulfilled");
  const paymentRows = paidOrders.map(({ o, id }) => ({
    orderId: id,
    gateway: "razorpay_test",
    gatewayOrderId: `order_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
    gatewayPaymentId: `pay_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
    amountMinor: o.totals!.totalMinor,
    currency: "INR",
    state: "captured" as const,
    idempotencyKey: `seed-${o.orderNumber}`,
    createdAt: o.createdAt as Date,
    updatedAt: o.createdAt as Date,
  }));
  for (let i = 0; i < paymentRows.length; i += 500) {
    await db.insert(schema.payments).values(paymentRows.slice(i, i + 500));
  }

  // ------------------------------------------- deliberate demo inventory states
  // The reference query is "black running shoes, size 10, under ₹5,000". These
  // overrides give the ranker genuine trade-offs instead of one obvious winner.
  async function setStock(
    merchantSlug: string,
    templateKey: string,
    attrs: Record<string, string>,
    quantity: number,
    lowStockThreshold = 5,
  ) {
    const ref = variantRefs.find(
      (v) =>
        v.merchantSlug === merchantSlug &&
        v.templateKey === templateKey &&
        Object.entries(attrs).every(([k, val]) => v.attributes[k] === val),
    );
    if (!ref) return;
    await sql`
      UPDATE inventory SET quantity = ${quantity}, low_stock_threshold = ${lowStockThreshold}
      WHERE variant_id = ${ref.variantId}
    `;
  }

  const black10 = { color: "black", size: "10" };
  await setStock("stride-athletics", "velocity-run-3", black10, 14);
  await setStock("budget-bazaar", "velocity-run-3", black10, 0); // cheapest, but unavailable
  await setStock("urban-outfit-co", "velocity-run-3", black10, 4); // low stock, premium price
  await setStock("budget-bazaar", "pace-lite-flyknit", black10, 9); // cheap, weak return policy
  await setStock("urban-outfit-co", "pace-lite-flyknit", black10, 6);
  await setStock("stride-athletics", "tempo-race-elite", black10, 5); // over budget
  await setStock("peak-gear", "trailblaze-gtx", black10, 7); // trail, not road

  // Alert-worthy states for the merchant dashboard and insights agent.
  await setStock("voltix-electronics", "pulse-buds-pro", { color: "black" }, 3);
  await setStock("hearth-and-home", "thermo-bottle-1l", { color: "black" }, 0);
  await setStock("voltix-electronics", "aurora-anc-headphones", { color: "silver" }, 2);

  // ------------------------------------------------------- default agent policies
  await db.insert(schema.agentPolicies).values([
    {
      scope: "platform",
      scopeId: null,
      limits: {
        maxOrderValueMinor: 50_000_00,
        maxDailySpendMinor: 100_000_00,
        maxItemsPerOrder: 10,
        requireApprovalAboveMinor: 0, // every payment needs explicit consent
        requireApprovalForAll: true,
        maxPriceChangeBp: 1000,
        maxDiscountBp: 2000,
        maxRestockUnits: 200,
        maxRestockCostMinor: 100_000_00,
        allowAutoPublish: false,
      },
    },
    ...customers.map((c) => ({
      scope: "user" as const,
      scopeId: c.id,
      limits: {
        maxOrderValueMinor: 25_000_00,
        maxDailySpendMinor: 50_000_00,
        maxItemsPerOrder: 10,
        requireApprovalAboveMinor: 0,
      },
    })),
    ...merchantRows.map((m) => ({
      scope: "merchant" as const,
      scopeId: m.id,
      limits: {
        maxPriceChangeBp: 1000,
        maxDiscountBp: 2500,
        maxRestockUnits: 250,
        maxRestockCostMinor: 200_000_00,
        allowAutoPublish: false,
        requireApprovalForAll: true,
      },
    })),
  ]);

  const [{ count: productCount }] = await sql<{ count: string }[]>`SELECT count(*) FROM products`;
  const [{ count: variantCount }] = await sql<{ count: string }[]>`SELECT count(*) FROM product_variants`;

  console.log(`
seeded:
  merchants     ${merchantRows.length}
  products      ${productCount}
  variants      ${variantCount}
  orders        ${insertedOrders.length}
  order items   ${itemRows.length}
  payments      ${paymentRows.length}

logins (password: ${DEMO_PASSWORD})
  customer  demo@shopper.test
  merchant  ${MERCHANTS[0].supportEmail}   (${MERCHANTS[0].name})
  admin     admin@acp.test

next: npm run catalog:index   # builds the AI-readable catalog + embeddings
`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
