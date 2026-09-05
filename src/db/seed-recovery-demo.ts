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
 *   2. card declined             -> customer_action_required -> message, then
 *                                                              a bounded offer
 *   3. three failures, one card  -> repeated_failure        -> STOP + escalate
 *   4. abandoned basket          -> abandoned_before_payment -> message
 *   5. no failure reason at all  -> unknown                 -> escalate
 *
 * **Each scenario gets its OWN shopper, and that is load-bearing.** The first
 * version put all five on `demo@shopper.test`, and the agent then did exactly
 * what it is supposed to: five failures from one person inside 72h IS payment
 * degradation, so `detectAll` collapsed the whole batch into a single escalated
 * case and swallowed the other four branches. The seed was promising five paths
 * and demonstrating one. Distinct shoppers are what make the scenarios distinct.
 *
 * Scenario 2 is deliberately left on `demo@shopper.test` so the demo login can
 * be used to read what the agent actually sent, from the shopper's side.
 *
 * Everything it creates is removable: orders are tagged `RECOVERY-DEMO` in the
 * order number, and the shoppers it invents live on `@recovery.demo`, whose
 * deletion cascades their carts, cases and threads away with them.
 */
const TAG = "RECOVERY-DEMO";
const DEMO_DOMAIN = "@recovery.demo";

/**
 * The cast, with names and addresses that differ from each other.
 *
 * Not decoration: the recovery board is searchable by shopper name, email and
 * order number, and a batch where every row says "Demo Shopper" cannot show
 * that working.
 */
const CAST = [
  { key: "TIMEOUT", name: "Aditi Rao", email: `aditi.rao${DEMO_DOMAIN}`,
    line1: "12 Turner Road", city: "Mumbai", state: "Maharashtra", postcode: "400050" },
  { key: "REPEAT", name: "Neha Kulkarni", email: `neha.kulkarni${DEMO_DOMAIN}`,
    line1: "8 Prabhat Road", city: "Pune", state: "Maharashtra", postcode: "411004" },
  { key: "BASKET", name: "Priya Menon", email: `priya.menon${DEMO_DOMAIN}`,
    line1: "45 Indiranagar 100ft Road", city: "Bengaluru", state: "Karnataka", postcode: "560038" },
  { key: "SILENT", name: "Rohan Iyer", email: `rohan.iyer${DEMO_DOMAIN}`,
    line1: "3 Besant Avenue", city: "Chennai", state: "Tamil Nadu", postcode: "600020" },
];

async function main() {
  const { db } = await import("@/db");
  const { sql } = await import("drizzle-orm");
  const { hash } = await import("bcryptjs");

  if (process.argv.includes("--reset")) {
    /*
     * Deleting the invented shoppers is the whole cleanup for four of the five
     * scenarios: orders, carts, cases and support threads all cascade from the
     * user row, so nothing can be left behind by a query that forgot a table.
     * Only the scenario planted on the real demo shopper needs picking out by
     * hand, and its order number is tagged for exactly that.
     */
    /*
     * Orders BEFORE shoppers. `orders.user_id` does not cascade — deliberately,
     * since a paid order is a financial record that should not vanish with an
     * account — so a shopper who has one cannot be deleted until it is gone.
     *
     * And EVERY order those shoppers hold, not merely the tagged ones. They
     * exist for this demo and nothing else, so anything they acquired along the
     * way — a retry, a checkout walked by hand — was made by the demo too.
     * Deleting only the tagged orders left the reset failing on its own
     * foreign key half way through, with the orders gone and the shoppers
     * still there: worse than not resetting at all.
     */
    const orders = (await db.execute(sql`
      DELETE FROM orders
      WHERE order_number LIKE ${`${TAG}%`}
         OR user_id IN (SELECT id FROM users WHERE email LIKE ${`%${DEMO_DOMAIN}`})
      RETURNING id`)) as unknown as unknown[];
    const people = (await db.execute(sql`
      DELETE FROM users WHERE email LIKE ${`%${DEMO_DOMAIN}`} RETURNING id`)) as unknown as unknown[];
    const threads = (await db.execute(sql`
      DELETE FROM support_threads
      WHERE subject LIKE 'Recovery needs a human%' OR subject LIKE 'You left%'
         OR subject LIKE 'Your%did not go through' RETURNING id`)) as unknown as unknown[];
    /*
     * One case does not cascade: a degradation case is about the SHOPPER, so it
     * holds no order or cart to be deleted with. The only way the real demo
     * shopper acquires one is the failures this seed planted, so removing it
     * with them is removing exactly what was made.
     */
    await db.execute(sql`
      DELETE FROM recovery_cases
      WHERE scenario = 'payment_degradation'
        AND user_id IN (SELECT id FROM users WHERE email = 'demo@shopper.test')`);
    /*
     * And clear the board itself, because "start fresh" means the merchant
     * presses Run a sweep and watches it find these five — not that they scroll
     * past whatever a previous run left behind.
     */
    const stale = (await db.execute(sql`
      DELETE FROM recovery_cases
      WHERE merchant_id IN (
        SELECT m.id FROM merchants m JOIN users u ON u.id = m.user_id
        WHERE u.email = 'care@stride.test'
      ) RETURNING id`)) as unknown as unknown[];
    console.log(`reset: ${stale.length} case(s) cleared from the demo merchant's board`);
    const promos = (await db.execute(sql`
      DELETE FROM promotions WHERE code LIKE 'BACK%' RETURNING id`)) as unknown as unknown[];
    console.log(
      `reset: ${people.length} demo shopper(s), ${orders.length} tagged order(s), ` +
        `${threads.length} thread(s), ${promos.length} promo code(s)\n`,
    );
  }

  /*
   * The DOCUMENTED demo merchant, not merely the first one with stock.
   *
   * Picking a merchant by "has more than three products" seeded the scenarios
   * into an account nobody has the password for, so the board the demo login
   * actually opens stayed empty while the data sat somewhere else. The
   * heuristic survives only as a fallback for a database seeded differently.
   */
  const [merchant] = (await db.execute(sql`
    SELECT m.id, m.name, u.email FROM merchants m
    JOIN users u ON u.id = m.user_id
    JOIN products p ON p.merchant_id = m.id AND p.status = 'active'
    WHERE m.status = 'active'
    GROUP BY m.id, u.email
    HAVING COUNT(*) > 3
    ORDER BY (u.email = 'care@stride.test') DESC
    LIMIT 1
  `)) as unknown as { id: string; name: string; email: string }[];
  const [demoShopper] = (await db.execute(sql`
    SELECT id, email, name FROM users WHERE email = 'demo@shopper.test' LIMIT 1
  `)) as unknown as { id: string; email: string; name: string }[];
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

  // The same password as every other demo account, so a reviewer can sign in
  // as any of these shoppers and read what the agent sent them.
  const passwordHash = await hash("demo1234", 10);
  const people: Record<string, { id: string; name: string; email: string }> = {};
  for (const person of CAST) {
    const [row] = (await db.execute(sql`
      INSERT INTO users (email, name, role, password_hash)
      VALUES (${person.email}, ${person.name}, 'customer', ${passwordHash})
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
      RETURNING id`)) as unknown as { id: string }[];
    people[person.key] = { id: row.id, name: person.name, email: person.email };

    /*
     * An address each, because the recovery loop only closes if the shopper can
     * actually check out. The abandoned-basket scenario is the one path a
     * person can walk to a captured payment by hand, and stalling it on an
     * empty address form would be demonstrating the address feature instead.
     */
    await db.execute(sql`
      INSERT INTO addresses (user_id, label, recipient, line1, city, state, postcode, is_default)
      SELECT ${row.id}, 'Home', ${person.name}, ${person.line1}, ${person.city},
             ${person.state}, ${person.postcode}, true
      WHERE NOT EXISTS (SELECT 1 FROM addresses a WHERE a.user_id = ${row.id})`);
  }

  const totals = (minor: number) =>
    JSON.stringify({
      subtotalMinor: minor, discountMinor: 0, shippingMinor: 0,
      taxMinor: 0, totalMinor: minor, currency: "INR",
    });

  /** One failed order for one shopper, with a chosen failure reason. */
  async function failedOrder(
    userId: string,
    label: string,
    amount: number,
    reason: string | null,
    ageHours = 3,
  ) {
    const [order] = (await db.execute(sql`
      INSERT INTO orders (order_number, user_id, merchant_id, state, totals, created_at, updated_at)
      VALUES (${`${TAG}-${label}-${Date.now() % 100000}`}, ${userId}, ${merchant.id},
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

  console.log(`seeding into ${merchant.name} (${merchant.email})\n`);

  await failedOrder(people.TIMEOUT.id, "TIMEOUT", 499_900, "gateway timeout while authorising");
  console.log(`  1. ₹4,999 gateway timeout      -> likely_temporary -> retry link   (${people.TIMEOUT.name})`);

  await failedOrder(demoShopper.id, "DECLINED", 349_900, "card declined by issuing bank");
  console.log(`  2. ₹3,499 declined by the bank -> customer action  -> message+offer (${demoShopper.email})`);

  // Three failures for the SAME shopper inside the window: degradation.
  for (let i = 0; i < 3; i++) {
    await failedOrder(people.REPEAT.id, `REPEAT${i}`, 259_900, "card declined by issuing bank", 6 + i);
  }
  console.log(`  3. three declines in 6h        -> repeated        -> STOP+escalate (${people.REPEAT.name})`);

  // An abandoned basket, old enough to be past the wait.
  const [cart] = (await db.execute(sql`
    INSERT INTO carts (user_id, merchant_id, status, currency, created_at, updated_at)
    VALUES (${people.BASKET.id}, ${merchant.id}, 'open', 'INR',
            now() - interval '30 hours', now() - interval '28 hours')
    RETURNING id`)) as unknown as { id: string }[];
  await db.execute(sql`
    INSERT INTO cart_items (cart_id, variant_id, quantity, unit_price_minor)
    VALUES (${cart.id}, ${variants[1].id}, 2, ${variants[1].price_minor})`);
  console.log(
    `  4. basket of ₹${(variants[1].price_minor * 2) / 100} left 28h ago -> abandoned       -> message      (${people.BASKET.name})`,
  );

  await failedOrder(people.SILENT.id, "SILENT", 289_900, null);
  console.log(`  5. ₹2,899, no reason given     -> unknown         -> escalate      (${people.SILENT.name})\n`);

  console.log(`Merchant view : sign in as ${merchant.email} (demo1234), open /merchant/recovery,`);
  console.log(`                then press 'Run a recovery sweep'.`);
  console.log(`Shopper view  : sign in as ${demoShopper.email} (demo1234) and open /support.\n`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
