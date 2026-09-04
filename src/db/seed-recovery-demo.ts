import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Plants one of each revenue-loss scenario so every path can be walked.
 *
 *   npm run db:seed-recovery-demo [-- --reset]
 *
 * The live catalogue only produces "signature does not match", which correctly
 * diagnoses as UNKNOWN and escalates — the honest outcome, but it means four of
 * the five paths through the agent are never exercised by real data. These are
 * deliberately shaped so each takes a different branch:
 *
 *   1. gateway timeout           -> likely_temporary        -> retry link
 *   2. card declined             -> customer_action_required -> message
 *   3. three failures, one card  -> repeated_failure        -> STOP + escalate
 *   4. abandoned basket          -> abandoned_before_payment -> message, then
 *                                                              a bounded offer
 *   5. no failure reason at all  -> unknown                 -> escalate
 *
 * Everything it creates is tagged `RECOVERY-DEMO` in the order number so
 * `--reset` can remove exactly what it made and nothing else.
 */
const TAG = "RECOVERY-DEMO";

async function main() {
  const { db } = await import("@/db");
  const { sql } = await import("drizzle-orm");

  if (process.argv.includes("--reset")) {
    const cases = (await db.execute(sql`
      DELETE FROM recovery_cases WHERE order_id IN (
        SELECT id FROM orders WHERE order_number LIKE ${`${TAG}%`}
      ) OR cart_id IN (
        SELECT c.id FROM carts c
        WHERE c.id IN (SELECT cart_id FROM recovery_cases)
          AND EXISTS (SELECT 1 FROM cart_items ci WHERE ci.cart_id = c.id)
          AND c.status = 'open'
      ) RETURNING id`)) as unknown as unknown[];
    const orders = (await db.execute(sql`
      DELETE FROM orders WHERE order_number LIKE ${`${TAG}%`} RETURNING id`)) as unknown as unknown[];
    const threads = (await db.execute(sql`
      DELETE FROM support_threads
      WHERE subject LIKE 'Recovery needs a human%' OR subject LIKE 'You left%'
         OR subject LIKE 'Your%did not go through' RETURNING id`)) as unknown as unknown[];
    const promos = (await db.execute(sql`
      DELETE FROM promotions WHERE code LIKE 'BACK%' RETURNING id`)) as unknown as unknown[];
    console.log(
      `reset: ${cases.length} cases, ${orders.length} orders, ${threads.length} threads, ${promos.length} promo codes\n`,
    );
  }

  // A merchant with real stock, and a shopper to buy it.
  const [merchant] = (await db.execute(sql`
    SELECT m.id, m.name FROM merchants m
    JOIN products p ON p.merchant_id = m.id AND p.status = 'active'
    WHERE m.status = 'active' GROUP BY m.id HAVING COUNT(*) > 3 LIMIT 1
  `)) as unknown as { id: string; name: string }[];
  const [shopper] = (await db.execute(sql`
    SELECT id, email FROM users WHERE email = 'demo@shopper.test' LIMIT 1
  `)) as unknown as { id: string; email: string }[];
  const variants = (await db.execute(sql`
    SELECT v.id, v.price_minor FROM product_variants v
    JOIN products p ON p.id = v.product_id
    WHERE p.merchant_id = ${merchant.id} AND v.active AND v.price_minor > 200000
    LIMIT 4
  `)) as unknown as { id: string; price_minor: number }[];

  if (variants.length < 3) {
    console.log("not enough stock over ₹2,000 to build the demo");
    process.exit(1);
  }

  const totals = (minor: number) =>
    JSON.stringify({
      subtotalMinor: minor, discountMinor: 0, shippingMinor: 0,
      taxMinor: 0, totalMinor: minor, currency: "INR",
    });

  /** One failed order with a chosen failure reason. */
  async function failedOrder(label: string, amount: number, reason: string | null, ageHours = 3) {
    const [order] = (await db.execute(sql`
      INSERT INTO orders (order_number, user_id, merchant_id, state, totals, created_at, updated_at)
      VALUES (${`${TAG}-${label}-${Date.now() % 100000}`}, ${shopper.id}, ${merchant.id},
              'payment_failed', ${totals(amount)}::jsonb,
              now() - interval '${sql.raw(String(ageHours))} hours',
              now() - interval '${sql.raw(String(ageHours))} hours')
      RETURNING id`)) as unknown as { id: string }[];

    await db.execute(sql`
      INSERT INTO order_items (order_id, variant_id, title_snapshot, sku_snapshot, attributes_snapshot, quantity, unit_price_minor)
      VALUES (${order.id}, ${variants[0].id}, ${`Demo item (${label})`}, ${`DEMO-${label}`}, '{}'::jsonb, 1, ${amount})`);

    await db.execute(sql`
      INSERT INTO payments (order_id, gateway, amount_minor, state, idempotency_key, failure_reason, created_at, updated_at)
      VALUES (${order.id}, 'mock', ${amount}, 'failed', ${`demo-${label}-${Date.now()}-${Math.random()}`},
              ${reason}, now() - interval '${sql.raw(String(ageHours))} hours',
              now() - interval '${sql.raw(String(ageHours))} hours')`);
    return order.id;
  }

  console.log(`seeding into ${merchant.name}, shopper ${shopper.email}\n`);

  await failedOrder("TIMEOUT", 499_900, "gateway timeout while authorising");
  console.log("  1. ₹4,999 failed on a gateway timeout      -> likely_temporary -> retry link");

  await failedOrder("DECLINED", 349_900, "card declined by issuing bank");
  console.log("  2. ₹3,499 declined by the bank             -> customer action  -> message");

  // Three failures for the same shopper inside the window: degradation.
  for (let i = 0; i < 3; i++) {
    await failedOrder(`REPEAT${i}`, 259_900, "card declined by issuing bank", 6 + i);
  }
  console.log("  3. three declines in 6h                    -> repeated        -> STOP + escalate");

  // An abandoned basket, old enough to be past the wait.
  const [cart] = (await db.execute(sql`
    INSERT INTO carts (user_id, merchant_id, status, currency, created_at, updated_at)
    VALUES (${shopper.id}, ${merchant.id}, 'open', 'INR',
            now() - interval '30 hours', now() - interval '28 hours')
    RETURNING id`)) as unknown as { id: string }[];
  await db.execute(sql`
    INSERT INTO cart_items (cart_id, variant_id, quantity, unit_price_minor)
    VALUES (${cart.id}, ${variants[1].id}, 2, ${variants[1].price_minor})`);
  console.log(`  4. basket of ${(variants[1].price_minor * 2) / 100} left 28h ago       -> abandoned       -> message, then offer`);

  await failedOrder("SILENT", 289_900, null);
  console.log("  5. ₹2,899 failed with no reason given      -> unknown         -> escalate\n");

  console.log("Now: sign in as the merchant and press 'Run a recovery sweep' on /merchant/recovery.");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
