import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });

/**
 * Create a problem by hand, so the agent can be watched finding it.
 *
 *   npm run recovery:simulate -- --abandon <email>
 *   npm run recovery:simulate -- --fail <email> --reason "gateway timeout" --amount 4999
 *
 * The seeded scenarios prove the branches exist; this is for asking "what
 * would it do with THIS?" — your own failure reason, your own amount, your own
 * basket. Everything it writes is an ordinary row the app would have written.
 *
 * `--abandon` only ages a basket the shopper already built. It does not invent
 * one, because a basket nobody chose is not an abandoned basket, and detection
 * runs on baskets older than an hour — which is the honest rule and also the
 * reason a basket you leave right now cannot be walked in real time.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const { db } = await import("@/db");
  const { sql } = await import("drizzle-orm");
  const q = async (t: ReturnType<typeof sql>) =>
    (await db.execute(t)) as unknown as Record<string, unknown>[];

  const email = arg("abandon") ?? arg("fail");
  if (!email) {
    console.log(`Usage:
  npm run recovery:simulate -- --abandon <shopper-email>
      Age that shopper's open baskets past the 1h threshold so the next sweep
      treats them as abandoned.

  npm run recovery:simulate -- --fail <shopper-email> [--reason "..."] [--amount 4999]
      Plant a failed payment with the reason you choose, to see which branch it
      takes. Omit --reason entirely to get the "no reason given" case.

Reasons that reach each diagnosis:
  "gateway timeout"               -> likely_temporary        -> retry link
  "card declined by issuing bank" -> customer_action_required -> message
  (omitted)                       -> unknown                 -> escalate
  anything unrecognised           -> unknown                 -> escalate\n`);
    process.exit(1);
  }

  const [shopper] = (await q(sql`
    SELECT id, name, email FROM users WHERE email = ${email} LIMIT 1
  `)) as unknown as { id: string; name: string; email: string }[];
  if (!shopper) {
    console.log(`No shopper with the address ${email}.`);
    process.exit(1);
  }

  // ------------------------------------------------------------- abandon
  if (arg("abandon")) {
    const hours = Number(arg("hours") ?? 28);
    const aged = await q(sql`
      UPDATE carts SET updated_at = now() - (${hours} * interval '1 hour')
      WHERE user_id = ${shopper.id} AND status = 'open'
        AND EXISTS (SELECT 1 FROM cart_items ci WHERE ci.cart_id = carts.id)
      RETURNING id`);
    console.log(
      aged.length === 0
        ? `${shopper.name} has no basket with anything in it. Add something first.`
        : `Aged ${aged.length} basket(s) of ${shopper.name} to ${hours}h old.\n` +
            `Run a sweep on /merchant/recovery to see them detected.`,
    );
    process.exit(0);
  }

  // ---------------------------------------------------------------- fail
  const reason = arg("reason") ?? null;
  const amountMinor = Math.round(Number(arg("amount") ?? 4999) * 100);
  const [merchant] = (await q(sql`
    SELECT m.id, m.name FROM merchants m JOIN users u ON u.id = m.user_id
    WHERE u.email = 'care@stride.test' LIMIT 1
  `)) as unknown as { id: string; name: string }[];
  const [variant] = (await q(sql`
    SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id
    WHERE p.merchant_id = ${merchant.id} AND v.active LIMIT 1
  `)) as unknown as { id: string }[];

  const totals = JSON.stringify({
    subtotalMinor: amountMinor, discountMinor: 0, shippingMinor: 0,
    taxMinor: 0, totalMinor: amountMinor, currency: "INR",
  });
  const [order] = (await q(sql`
    INSERT INTO orders (order_number, user_id, merchant_id, state, totals, created_at, updated_at)
    VALUES (${`RECOVERY-DEMO-SIM-${Date.now() % 1000000}`}, ${shopper.id}, ${merchant.id},
            'payment_failed', ${totals}::jsonb, now() - interval '3 hours', now() - interval '3 hours')
    RETURNING id, order_number`)) as unknown as { id: string; order_number: string }[];

  await q(sql`
    INSERT INTO order_items (order_id, variant_id, title_snapshot, sku_snapshot, attributes_snapshot, quantity, unit_price_minor)
    VALUES (${order.id}, ${variant.id}, 'Simulated item', 'SIM-1', '{}'::jsonb, 1, ${amountMinor})`);
  await q(sql`
    INSERT INTO payments (order_id, gateway, amount_minor, state, idempotency_key, failure_reason, created_at, updated_at)
    VALUES (${order.id}, 'mock', ${amountMinor}, 'failed', ${`sim-${Date.now()}`}, ${reason},
            now() - interval '3 hours', now() - interval '3 hours')`);

  console.log(`Planted ${order.order_number} for ${shopper.name} — ₹${amountMinor / 100} failed`);
  console.log(reason ? `  reason: "${reason}"` : `  reason: none given`);
  console.log(`\nIt is tagged RECOVERY-DEMO, so \`db:seed-recovery-demo -- --reset\` removes it.`);
  console.log(`Run a sweep on /merchant/recovery to see how it is diagnosed.`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
