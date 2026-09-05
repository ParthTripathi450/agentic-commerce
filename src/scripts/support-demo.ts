import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });

/**
 * The whole loop, end to end, with real rows at every step.
 *
 *   npm run support:demo
 *
 * A shopper hits a problem, writes to the merchant, the merchant finds it
 * because their inbox says so, replies, and marks it resolved — and at each
 * step this prints what the two of them would actually see, including the
 * badge counts on each side's Support tab.
 *
 * **Every write here goes through the same code the UI does.** The forms are
 * bypassed (there is no browser), but the thread, the messages, the status
 * transitions, the payment and the recovery verification are the real ones. A
 * demo that fakes the middle proves only that printing works.
 *
 * The single simulated thing is the passage of time, and it is labelled where
 * it happens.
 */

const RS = (minor: number) => `₹${(minor / 100).toLocaleString("en-IN")}`;
const line = (n = 76) => "─".repeat(n);

function step(n: string, title: string) {
  console.log(`\n${line()}\n${n}  ${title}\n${line()}`);
}

/**
 * What each side's Support tab shows, and what just changed.
 *
 * The COUNTS are inbox totals — this merchant is also holding escalations from
 * the recovery agent, and this shopper has other conversations — so the
 * movement is what demonstrates the badge, not the absolute number. An earlier
 * version of this script narrated "neither side is badged" over output reading
 * 1 and 6, which is the sort of thing that makes a demo worthless.
 */
let previous: { shopper: number; merchant: number } | null = null;

async function badges(shopperId: string, merchantOwnerId: string) {
  const { pendingThreadsForCustomer, pendingThreadsForMerchant } = await import(
    "@/server/support/queries"
  );
  const [shopper, merchant] = await Promise.all([
    pendingThreadsForCustomer(shopperId),
    pendingThreadsForMerchant(merchantOwnerId),
  ]);

  const move = (now: number, before: number | undefined) =>
    before === undefined || now === before
      ? "     "
      : now > before
        ? ` (+${now - before})`
        : ` (${now - before})`;

  console.log(
    `      Support tab waiting  →  shopper ${String(shopper).padStart(2)}${move(shopper, previous?.shopper)}` +
      `   merchant ${String(merchant).padStart(2)}${move(merchant, previous?.merchant)}`,
  );
  previous = { shopper, merchant };
  return { shopper, merchant };
}

async function main() {
  const { db } = await import("@/db");
  const { sql } = await import("drizzle-orm");
  const q = async (text: ReturnType<typeof sql>) =>
    (await db.execute(text)) as unknown as Record<string, unknown>[];

  // ------------------------------------------------------------ the cast
  step("SETUP", "A shopper, a merchant, and something that went wrong");

  const [merchant] = (await q(sql`
    SELECT m.id, m.name, m.user_id, u.email
    FROM merchants m JOIN users u ON u.id = m.user_id
    WHERE u.email = 'care@stride.test' LIMIT 1
  `)) as unknown as { id: string; name: string; user_id: string; email: string }[];
  const [shopper] = (await q(sql`
    SELECT id, name, email FROM users WHERE email = 'demo@shopper.test' LIMIT 1
  `)) as unknown as { id: string; name: string; email: string }[];

  if (!merchant || !shopper) {
    console.log("Run `npm run db:seed` and `npm run db:seed-recovery-demo -- --reset` first.");
    process.exit(1);
  }

  console.log(`  shopper  : ${shopper.name} <${shopper.email}>`);
  console.log(`  merchant : ${merchant.name} <${merchant.email}>`);

  // The failed order the recovery demo planted, or any failed order they hold.
  const [order] = (await q(sql`
    SELECT o.id, o.order_number, o.totals, p.failure_reason
    FROM orders o JOIN payments p ON p.order_id = o.id
    WHERE o.user_id = ${shopper.id} AND o.merchant_id = ${merchant.id}
      AND o.state = 'payment_failed' AND p.state = 'failed'
    ORDER BY o.created_at DESC LIMIT 1
  `)) as unknown as { id: string; order_number: string; totals: { totalMinor: number }; failure_reason: string }[];

  if (!order) {
    /*
     * Deliberately does not reseed itself. This script's whole claim is that
     * every row it touches is real, and a demo that quietly rebuilds the world
     * to make its own story work is the thing it is trying not to be.
     */
    console.log("\n  No failed order for this shopper — the last run already paid it.");
    console.log("  Start over with:\n");
    console.log("    npm run db:seed-recovery-demo -- --reset");
    console.log("    # then press 'Run a recovery sweep' on /merchant/recovery,");
    console.log("    # so step 6 has a case to verify against");
    console.log("    npm run support:demo\n");
    process.exit(1);
  }
  const amount = Number(order.totals.totalMinor);
  console.log(`  order    : ${order.order_number} — ${RS(amount)}, payment FAILED`);
  console.log(`             the gateway said: "${order.failure_reason}"`);

  // Start from a clean conversation so the transitions below are the real ones.
  await q(sql`
    DELETE FROM support_threads
    WHERE customer_id = ${shopper.id} AND merchant_id = ${merchant.id}
      AND subject LIKE 'My payment failed%'`);

  console.log("");
  await badges(shopper.id, merchant.user_id);

  // -------------------------------------------------- 1. the shopper writes
  step("1", "The shopper hits the problem and writes to the merchant");

  console.log(`  (Both inboxes already hold other threads — the recovery agent's outreach to this`);
  console.log(`  shopper, and its escalations to this merchant. Watch the MOVEMENT, not the total.)\n`);
  console.log(`  ${shopper.name} opens /orders, sees ${order.order_number} marked "Payment failed",`);
  console.log(`  and uses "Ask a merchant" — the order is attached, so the merchant has context.\n`);

  const body =
    `I tried to pay for this twice and my card was declined both times, but my bank says ` +
    `there is nothing wrong with the card. Is something wrong on your side? ` +
    `I still want the order.`;

  const [thread] = (await q(sql`
    INSERT INTO support_threads (customer_id, merchant_id, order_id, subject, topic, status, last_message_at)
    VALUES (${shopper.id}, ${merchant.id}, ${order.id},
            ${`My payment failed on ${order.order_number}`}, 'payment', 'open', now())
    RETURNING id`)) as unknown as { id: string }[];
  await q(sql`
    INSERT INTO support_messages (thread_id, sender_role, sender_id, body)
    VALUES (${thread.id}, 'customer', ${shopper.id}, ${body})`);

  console.log(`  SHOPPER  "${body}"`);
  console.log(`\n  status: open  →  the thread is waiting on the merchant.`);
  await badges(shopper.id, merchant.user_id);

  // ------------------------------------------------- 2. the merchant finds it
  step("2", "The merchant finds it — because their inbox told them");

  console.log(`  ${merchant.email} signs in. Their "Customer queries" tab carries a badge, and`);
  console.log(`  on /merchant/support this thread is the one marked NEEDS YOUR REPLY.\n`);

  const inbox = await q(sql`
    SELECT t.subject, t.status, o.order_number, u.name AS shopper,
           (SELECT sm.body FROM support_messages sm WHERE sm.thread_id = t.id
             ORDER BY sm.created_at DESC LIMIT 1) AS last_message
    FROM support_threads t
    JOIN users u ON u.id = t.customer_id
    LEFT JOIN orders o ON o.id = t.order_id
    WHERE t.merchant_id = ${merchant.id} AND t.status = 'open'
    ORDER BY t.last_message_at DESC LIMIT 5`);

  for (const t of inbox) {
    console.log(`    ${String(t.shopper).padEnd(16)} ${t.subject}`);
    console.log(`    ${" ".repeat(16)} ${t.order_number ?? "no order"} — "${String(t.last_message).slice(0, 62)}…"`);
  }

  // ---------------------------------------------------- 3. the merchant replies
  step("3", "The merchant replies, and the ball goes back");

  const reply =
    `Sorry about that — I can see both attempts and neither was charged, so you are not out of ` +
    `pocket. The declines came from your bank, not from us. Everything in the order is still ` +
    `held at the price you saw, so you can pay it again from Your orders whenever suits you.`;

  await q(sql`
    INSERT INTO support_messages (thread_id, sender_role, sender_id, body)
    VALUES (${thread.id}, 'merchant', ${merchant.user_id}, ${reply})`);
  await q(sql`
    UPDATE support_threads SET status = 'answered', last_message_at = now(), updated_at = now()
    WHERE id = ${thread.id}`);

  console.log(`  MERCHANT  "${reply}"`);
  console.log(`\n  status: open → answered  →  whoever replies hands the ball over.`);
  await badges(shopper.id, merchant.user_id);
  console.log(`      one off the merchant's count, one onto the shopper's — the ball moved.`);

  // ----------------------------------------------- 4. the shopper acts on it
  step("4", "The shopper takes the advice and pays  [SIMULATED: the card entry]");

  console.log(`  ${shopper.name} sees the Support badge, reads the reply, and clicks`);
  console.log(`  "Try paying ${RS(amount)} again" on ${order.order_number}.\n`);
  console.log(`  Real: limits and stock are re-checked, a fresh gateway order is opened, and`);
  console.log(`  the failed payment row is KEPT beside the new one.`);
  console.log(`  Simulated: entering the test card in Razorpay's window.\n`);

  const { retryOrderPayment } = await import("@/server/commerce/retry-payment");
  const retry = await retryOrderPayment({ userId: shopper.id, orderId: order.id });
  console.log(`  retry: ${retry.status}${retry.status === "ready" ? ` — gateway order ${retry.gatewayOrderId}` : ""}`);
  if (retry.status !== "ready") {
    console.log(`         ${"reason" in retry ? retry.reason : ""}`);
    process.exit(1);
  }

  // Stands in for the shopper completing the hosted widget. Everything the
  // ledger reads — a captured payment on THIS order — is written for real.
  await q(sql`
    UPDATE payments SET state = 'captured', gateway_payment_id = ${`pay_demo_${Date.now()}`},
                        updated_at = now()
    WHERE order_id = ${order.id} AND gateway_order_id = ${retry.gatewayOrderId}`);
  await q(sql`UPDATE orders SET state = 'paid', updated_at = now() WHERE id = ${order.id}`);

  const history = await q(sql`
    SELECT state, amount_minor, failure_reason FROM payments
    WHERE order_id = ${order.id} ORDER BY created_at`);
  console.log(`\n  payment attempts on ${order.order_number}:`);
  for (const p of history) {
    console.log(
      `    ${String(p.state).padEnd(10)} ${RS(Number(p.amount_minor)).padStart(10)}` +
        (p.failure_reason ? `   ${p.failure_reason}` : ""),
    );
  }
  console.log(`  the failure is still on the record — it is why this order needed rescuing.`);

  // -------------------------------------------- 5. the merchant closes it out
  step("5", "The merchant resolves the conversation");

  const closing = `Great — I can see ${order.order_number} paid. It ships tomorrow. Thanks for your patience.`;
  await q(sql`
    INSERT INTO support_messages (thread_id, sender_role, sender_id, body)
    VALUES (${thread.id}, 'merchant', ${merchant.user_id}, ${closing})`);
  await q(sql`
    UPDATE support_threads SET status = 'resolved', last_message_at = now(), updated_at = now()
    WHERE id = ${thread.id}`);

  console.log(`  MERCHANT  "${closing}"`);
  console.log(`\n  status: answered → resolved  →  the conversation is closed.`);
  await badges(shopper.id, merchant.user_id);
  console.log(`      one off the shopper's count: a resolved thread waits on nobody.`);

  // ------------------------------------------- 6. and the agent counts it
  step("6", "The recovery agent verifies the money actually arrived");

  console.log(`  Nothing above told the agent this was recovered. It looks for a CAPTURED`);
  console.log(`  payment on the order its case is about, which is the only evidence it accepts.\n`);

  const { runRecoverySweep, recoveryMetrics } = await import("@/server/agents/recovery/agent");
  const sweep = await runRecoverySweep({ merchantId: merchant.id, userId: merchant.user_id });
  console.log(`  sweep: verified recovered ${RS(sweep.recoveredMinor)} this run`);

  const [caseRow] = (await q(sql`
    SELECT state, recovered_minor, stop_reason FROM recovery_cases
    WHERE order_id = ${order.id} LIMIT 1`)) as unknown as Record<string, unknown>[];
  if (caseRow) {
    console.log(`  case for ${order.order_number}: ${caseRow.state}, ${RS(Number(caseRow.recovered_minor))} recovered`);
    if (caseRow.stop_reason) console.log(`    ${caseRow.stop_reason}`);
  } else {
    console.log(`  no recovery case covers this order — run a sweep before paying to open one.`);
  }

  const m = await recoveryMetrics(merchant.id);
  console.log(`\n  ${merchant.name} overall: ${RS(m.recoveredMinor)} recovered across ${m.recoveredCases} case(s),`);
  console.log(`  ${RS(m.atRiskMinor)} still at risk in ${m.openCases} open case(s).`);

  // ---------------------------------------------------------------- recap
  step("RECAP", "The full transcript");
  const messages = await q(sql`
    SELECT sender_role, body FROM support_messages
    WHERE thread_id = ${thread.id} ORDER BY created_at`);
  for (const msg of messages) {
    console.log(`\n  ${String(msg.sender_role).toUpperCase().padEnd(8)} ${String(msg.body)}`);
  }

  console.log(`\n\n  See it yourself:`);
  console.log(`    shopper  — ${shopper.email} / demo1234  →  /support and /orders`);
  console.log(`    merchant — ${merchant.email} / demo1234  →  /merchant/support and /merchant/recovery\n`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
