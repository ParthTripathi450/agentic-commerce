import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });

/**
 * An end-to-end demonstration of the revenue recovery agent, with real numbers.
 *
 *   npm run recovery:demo
 *
 * Seeds a controlled batch, runs the real agent over it, has some shoppers come
 * back and pay, and prints what actually happened: money at risk, money
 * recovered, which cases escalated and why, where the stopping rules fired, and
 * the audit trail behind one case.
 *
 * **What is real and what is simulated, stated plainly**, because a demo that
 * blurs the two proves nothing:
 *
 *   REAL  — the orders, carts, payments and failure reasons in the database;
 *           every stage of the agent; the policy checks; the support threads
 *           and discount codes it creates; the audit events; every number below.
 *   SIMULATED — shoppers returning to pay, and the passage of time. A demo
 *           cannot wait 24 hours for a cooldown or for a real customer to
 *           change their mind, so those two are forced and labelled where they
 *           happen. Nothing else is.
 */

const RS = (minor: number) => `₹${(minor / 100).toLocaleString("en-IN")}`;
const line = (n = 74) => "─".repeat(n);

function heading(step: string, title: string) {
  console.log(`\n${line()}\n${step}  ${title}\n${line()}`);
}

async function main() {
  const { db } = await import("@/db");
  const { sql } = await import("drizzle-orm");
  const { runRecoverySweep, recoveryMetrics } = await import("@/server/agents/recovery/agent");

  const q = async (text: ReturnType<typeof sql>) =>
    (await db.execute(text)) as unknown as Record<string, unknown>[];

  // ------------------------------------------------------------- setup
  heading("SETUP", "A controlled batch of revenue at risk");

  const [merchant] = (await q(sql`
    SELECT m.id, m.name, m.user_id, u.email
    FROM merchants m JOIN users u ON u.id = m.user_id
    WHERE m.name = 'Sole Republic' LIMIT 1
  `)) as unknown as { id: string; name: string; user_id: string; email: string }[];
  if (!merchant) {
    console.log("Run `npm run db:seed-recovery-demo` first.");
    process.exit(1);
  }

  // Start from a known state so the numbers below are reproducible.
  await q(sql`DELETE FROM recovery_cases WHERE merchant_id = ${merchant.id}`);
  await q(sql`
    DELETE FROM support_threads
    WHERE merchant_id = ${merchant.id}
      AND (subject LIKE 'You left%' OR subject LIKE 'Your%did not go through'
           OR subject LIKE 'Recovery needs a human%')`);
  await q(sql`DELETE FROM promotions WHERE merchant_id = ${merchant.id} AND code LIKE 'BACK%'`);

  console.log(`  merchant : ${merchant.name}  (${merchant.email})`);
  const [pool] = await q(sql`
    SELECT
      (SELECT COUNT(*) FROM orders o JOIN payments p ON p.order_id = o.id
        WHERE o.merchant_id = ${merchant.id} AND p.state = 'failed'
          AND o.state IN ('pending_payment','payment_failed')) AS failed,
      (SELECT COUNT(*) FROM carts c JOIN cart_items ci ON ci.cart_id = c.id
        WHERE c.merchant_id = ${merchant.id} AND c.status = 'open') AS baskets
  `);
  console.log(`  in the data: ${pool.failed} failed payment(s), ${pool.baskets} open basket(s)`);

  // ------------------------------------------------- detect + diagnose
  heading("SWEEP 1", "DETECT → DIAGNOSE → DETERMINE → POLICY → ACT");
  const first = await runRecoverySweep({ merchantId: merchant.id, userId: merchant.user_id });
  console.log(
    `  detected ${first.detected}   contacted ${first.acted}   escalated ${first.escalated}   ` +
      `stopped ${first.stopped}   deferred ${first.deferred}`,
  );
  console.log(`  at risk after this sweep: ${RS(first.atRiskMinor)}`);

  const diagnoses = await q(sql`
    SELECT diagnosis, COUNT(*) n, SUM(amount_at_risk_minor) v
    FROM recovery_cases WHERE merchant_id = ${merchant.id}
    GROUP BY diagnosis ORDER BY v DESC
  `);
  console.log(`\n  what the evidence supported:`);
  for (const d of diagnoses) {
    console.log(
      `    ${String(d.diagnosis ?? "-").padEnd(26)} ${String(d.n).padStart(3)} case(s)  ${RS(Number(d.v)).padStart(12)}`,
    );
  }

  // -------------------------------------------------------- escalation
  heading("COMPLIANT ESCALATION", "Cases the agent refused to act on");
  const escalated = await q(sql`
    SELECT amount_at_risk_minor, diagnosis, stop_reason
    FROM recovery_cases
    WHERE merchant_id = ${merchant.id} AND state = 'escalated'
    ORDER BY amount_at_risk_minor DESC LIMIT 5
  `);
  if (escalated.length === 0) {
    console.log("  none in this batch.");
  } else {
    for (const e of escalated) {
      console.log(`  ${RS(Number(e.amount_at_risk_minor)).padStart(12)}  ${e.diagnosis}`);
      console.log(`                ${e.stop_reason}`);
    }
  }
  const [threads] = await q(sql`
    SELECT COUNT(*) n FROM support_threads
    WHERE merchant_id = ${merchant.id} AND subject LIKE 'Recovery needs a human%'`);
  console.log(`\n  ${threads.n} escalation thread(s) opened to the merchant, reasoning attached.`);

  // ------------------------------------------------- shoppers come back
  heading("RECOVERY", "Shoppers return and pay  [SIMULATED: the payments]");
  const contacted = await q(sql`
    SELECT id, user_id, cart_id, order_id, amount_at_risk_minor
    FROM recovery_cases
    WHERE merchant_id = ${merchant.id} AND state = 'verifying'
    ORDER BY amount_at_risk_minor DESC LIMIT 3
  `);

  let simulated = 0;
  for (const c of contacted) {
    const amount = Number(c.amount_at_risk_minor);
    const totals = JSON.stringify({
      subtotalMinor: amount, discountMinor: 0, shippingMinor: 0,
      taxMinor: 0, totalMinor: amount, currency: "INR",
    });

    if (c.cart_id) {
      const [cs] = await q(sql`
        INSERT INTO checkout_sessions (cart_id, user_id, merchant_id, state, totals, expires_at)
        VALUES (${String(c.cart_id)}, ${String(c.user_id)}, ${merchant.id}, 'completed',
                ${totals}::jsonb, now() + interval '1 day') RETURNING id`);
      const [o] = await q(sql`
        INSERT INTO orders (order_number, user_id, merchant_id, checkout_session_id, state, totals)
        VALUES (${`REC-${Date.now()}-${simulated}`}, ${String(c.user_id)}, ${merchant.id},
                ${String(cs.id)}, 'paid', ${totals}::jsonb) RETURNING id`);
      await q(sql`
        INSERT INTO payments (order_id, gateway, amount_minor, state, idempotency_key)
        VALUES (${String(o.id)}, 'mock', ${amount}, 'captured', ${`rec-${Date.now()}-${simulated}`})`);
    } else if (c.order_id) {
      await q(sql`
        INSERT INTO payments (order_id, gateway, amount_minor, state, idempotency_key)
        VALUES (${String(c.order_id)}, 'mock', ${amount}, 'captured', ${`rec-${Date.now()}-${simulated}`})`);
      await q(sql`UPDATE orders SET state = 'paid' WHERE id = ${String(c.order_id)}`);
    }
    console.log(`  shopper paid ${RS(amount)}`);
    simulated++;
  }
  if (simulated === 0) console.log("  no contacted cases to recover in this batch.");

  heading("SWEEP 2", "VERIFY — money is counted only from a captured payment");
  const second = await runRecoverySweep({ merchantId: merchant.id, userId: merchant.user_id });
  console.log(`  verified recovered this sweep: ${RS(second.recoveredMinor)}`);

  // ----------------------------------------------------- stopping rules
  heading("STOPPING RULES", "Driving one case to its limit  [SIMULATED: the 24h cooldowns]");
  const [subject] = await q(sql`
    SELECT id, amount_at_risk_minor, message_count FROM recovery_cases
    WHERE merchant_id = ${merchant.id} AND state = 'verifying'
    ORDER BY amount_at_risk_minor DESC LIMIT 1`);

  if (!subject) {
    console.log("  no live case to push to its limit.");
  } else {
    console.log(`  case worth ${RS(Number(subject.amount_at_risk_minor))}, ${subject.message_count} message(s) sent so far`);
    for (let i = 0; i < 3; i++) {
      // Fast-forward the cooldown. Everything else is the real agent.
      await q(sql`UPDATE recovery_cases SET next_action_at = NULL WHERE id = ${String(subject.id)}`);
      await runRecoverySweep({ merchantId: merchant.id, userId: merchant.user_id });
      const [now] = await q(sql`
        SELECT state, message_count, stop_reason FROM recovery_cases WHERE id = ${String(subject.id)}`);
      console.log(
        `    after sweep ${i + 3}: ${String(now.state).padEnd(12)} ${now.message_count} message(s)` +
          (now.stop_reason ? `\n      STOPPED: ${now.stop_reason}` : ""),
      );
      if (now.stop_reason) break;
    }
  }

  // ------------------------------------------------------------- audit
  heading("AUDIT TRAIL", "One case, every step the agent took");
  const [audited] = await q(sql`
    SELECT rc.id, rc.amount_at_risk_minor, rc.session_id
    FROM recovery_cases rc
    WHERE rc.merchant_id = ${merchant.id} AND rc.session_id IS NOT NULL
      AND rc.state IN ('recovered','stopped','escalated')
    ORDER BY rc.amount_at_risk_minor DESC LIMIT 1`);

  if (audited) {
    const events = await q(sql`
      SELECT step, observation, reasoning, outcome, action
      FROM agent_events WHERE session_id = ${String(audited.session_id)}
      ORDER BY sequence ASC LIMIT 200`);
    const mine = events.filter((e) => {
      const p = (e.action as { params?: { caseId?: string } })?.params;
      return !p?.caseId || p.caseId === String(audited.id);
    });
    console.log(`  case worth ${RS(Number(audited.amount_at_risk_minor))} — ${mine.length} recorded step(s)\n`);
    for (const e of mine.slice(0, 8)) {
      console.log(`  ${String(e.step).padEnd(13)} ${(e.observation as { summary?: string })?.summary ?? ""}`);
      const why = (e.reasoning as { summary?: string })?.summary;
      if (why) console.log(`                ${why}`);
    }
  }

  // ----------------------------------------------------------- summary
  heading("MEASURED RESULT", "Across the whole batch");
  const m = await recoveryMetrics(merchant.id);
  const totalHandled = m.recoveredMinor + m.atRiskMinor;
  console.log(`  revenue detected at risk    ${RS(totalHandled).padStart(14)}`);
  console.log(`  revenue verified recovered  ${RS(m.recoveredMinor).padStart(14)}   (${m.recoveredCases} case(s))`);
  console.log(`  still at risk               ${RS(m.atRiskMinor).padStart(14)}   (${m.openCases} open)`);
  console.log(`  escalated to a human        ${String(m.escalatedCases).padStart(14)}`);
  console.log(`  stopped by the rules        ${String(m.stoppedCases).padStart(14)}`);
  console.log(
    `  recovery rate               ${(m.recoveryRate === null ? "—" : `${Math.round(m.recoveryRate * 100)}%`).padStart(14)}   of cases that reached an end`,
  );

  const [contactCount] = await q(sql`
    SELECT COUNT(DISTINCT user_id) n FROM recovery_cases
    WHERE merchant_id = ${merchant.id} AND message_count > 0`);
  console.log(`\n  distinct shoppers contacted ${String(contactCount.n).padStart(14)}   (daily cap 25, 10 per sweep)`);
  console.log(`\n  See it in the UI: /merchant/recovery as ${merchant.email}\n`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
