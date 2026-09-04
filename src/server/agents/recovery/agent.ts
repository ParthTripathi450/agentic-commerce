import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { approvals, merchants, recoveryCases } from "@/db/schema";
import { formatMoney } from "@/lib/money";
import { record, startSession } from "@/server/audit/recorder";
import { evaluatePolicy } from "@/server/policy/engine";
import {
  composeMessage,
  escalateToMerchant,
  grantRecoveryIncentive,
  recoveryLink,
  sendRecoveryMessage,
} from "./act";
import { detectAll, type DetectedCase } from "./detect";
import { diagnoseAbandonment, diagnoseDegradation, diagnoseFailedPayment, type Diagnosis } from "./diagnose";
import { determineAction, DEFAULT_RECOVERY_LIMITS, type RecoveryLimits } from "./determine";
import { verifyCartConverted, verifyOrderPaid, verifyShopperPaying } from "./verify";

/**
 * The AI Revenue Recovery Agent.
 *
 * DETECT → DIAGNOSE → DETERMINE → POLICY → ACT → VERIFY → RECORD, run as an
 * explicit sequence of stages rather than a conversation. Each stage is a
 * separate, testable function and each writes its own entry to the append-only
 * `agent_events` trail, so a case can be read back as the argument it actually
 * made rather than a summary written afterwards.
 *
 * **The model never decides and never spends.** Detection is SQL, diagnosis is
 * a mapping from evidence, the choice of action is a decision table, and the
 * bounds are enforced by the same policy engine that gates customer payments.
 * The only place a model could sit is phrasing an outreach message, and even
 * that is deterministic today — every sentence a shopper reads states a fact
 * the case already holds.
 *
 * **Verification is separate from action on purpose.** An agent that counted a
 * sent message as a recovery would be reporting a number entirely within its
 * own control. Revenue is only ever counted from a captured payment.
 */

export type SweepResult = {
  merchantId: string;
  detected: number;
  atRiskMinor: number;
  acted: number;
  awaitingApproval: number;
  escalated: number;
  stopped: number;
  recoveredMinor: number;
  /** Left for the next sweep because this run hit its contact budget. */
  deferred: number;
  cases: string[];
};

/** Cases the sweep will pick up again. */
const LIVE_STATES = ["detected", "diagnosed", "acting", "verifying"] as const;

async function limitsFor(merchantId: string): Promise<RecoveryLimits> {
  // Resolved through the policy engine so a merchant's own settings win, with
  // the platform defaults underneath — the same precedence every other bounded
  // action in this system uses.
  const decision = await evaluatePolicy({ type: "recovery_message", messagesSoFar: 0 }, { merchantId });
  const l = decision.limits;
  return {
    maxRetries: l.maxRecoveryRetries ?? DEFAULT_RECOVERY_LIMITS.maxRetries,
    maxMessages: l.maxRecoveryMessages ?? DEFAULT_RECOVERY_LIMITS.maxMessages,
    maxDiscountBp: l.maxRecoveryDiscountBp ?? DEFAULT_RECOVERY_LIMITS.maxDiscountBp,
    maxDiscountMinor: l.maxRecoveryDiscountMinor ?? DEFAULT_RECOVERY_LIMITS.maxDiscountMinor,
    minValueMinor: DEFAULT_RECOVERY_LIMITS.minValueMinor,
    maxActionsPerSweep: l.maxRecoveryActionsPerSweep ?? 10,
    maxContactsPerDay: l.maxRecoveryContactsPerDay ?? 25,
  };
}

/**
 * How many shoppers this merchant has already contacted today.
 *
 * Counted from the cases themselves rather than a counter, so it stays true
 * across restarts and cannot drift from what actually happened.
 */
async function contactsToday(merchantId: string): Promise<number> {
  const [row] = (await db.execute(sql`
    SELECT COUNT(DISTINCT user_id)::int AS n
    FROM recovery_cases
    WHERE merchant_id = ${merchantId}
      AND message_count > 0
      AND updated_at > now() - interval '24 hours'
  `)) as unknown as { n: number }[];
  return row?.n ?? 0;
}

function diagnoseFor(detected: DetectedCase): Diagnosis {
  const e = detected.evidence;
  switch (detected.scenario) {
    case "failed_payment":
      return diagnoseFailedPayment({
        failureReason: (e.failureReason as string) ?? null,
        recentFailureCount: Number(e.recentFailureCount ?? 0),
        priorAttempts: 0,
      });
    case "abandoned_checkout":
      return diagnoseAbandonment({
        paymentAttempted: Boolean(e.paymentAttempted),
        hoursSinceAbandoned: Number(e.hoursSinceAbandoned ?? 0),
        priorAbandonments: Number(e.priorAbandonments ?? 0),
      });
    case "payment_degradation":
      return diagnoseDegradation({
        failureCount: Number(e.failureCount ?? 0),
        windowHours: Number(e.windowHours ?? 72),
        distinctOrders: Number(e.distinctOrders ?? 0),
      });
  }
}

/**
 * DETECT + open a case for anything new.
 *
 * Opening the case is separate from working it so a merchant can see what is at
 * risk before any action is taken — and so a sweep interrupted halfway leaves
 * the risk recorded rather than lost.
 */
async function openCases(merchantId: string, sessionId: string): Promise<string[]> {
  const detected = await detectAll(merchantId);

  await record(sessionId, {
    step: "DETECT",
    observation: {
      summary:
        `Detected ${detected.length} case(s) of revenue at risk worth ` +
        `${formatMoney(detected.reduce((s, c) => s + c.amountAtRiskMinor, 0))}.`,
      inputs: { scenarios: detected.map((c) => c.scenario) },
    },
    reasoning: { summary: "Deterministic detection over payments, carts and checkout sessions." },
    action: { type: "recovery_detect" },
    outcome: { status: "ok", detail: `${detected.length} at risk` },
  });

  const opened: string[] = [];
  for (const item of detected) {
    const diagnosis = diagnoseFor(item);
    try {
      const [row] = await db
        .insert(recoveryCases)
        .values({
          merchantId: item.merchantId,
          userId: item.userId,
          scenario: item.scenario,
          state: "diagnosed",
          orderId: item.orderId ?? null,
          cartId: item.cartId ?? null,
          paymentId: item.paymentId ?? null,
          amountAtRiskMinor: item.amountAtRiskMinor,
          currency: item.currency,
          diagnosis: diagnosis.category,
          evidence: { ...item.evidence, diagnosis },
          sessionId,
        })
        .returning();
      opened.push(row.id);

      await record(sessionId, {
        step: "DIAGNOSE",
        observation: {
          summary: `${item.scenario}: ${formatMoney(item.amountAtRiskMinor)} at risk.`,
          inputs: item.evidence,
        },
        reasoning: {
      summary: diagnosis.summary,
      // The signals it was concluded FROM, so the case can be argued with.
      tradeoffs: diagnosis.basis.join(" · "),
    },
        action: { type: "recovery_diagnose", params: { caseId: row.id } },
        outcome: { status: "ok", detail: `${diagnosis.category} (${diagnosis.confidence} confidence)` },
      });
    } catch {
      /*
       * The unique index rejected it — another sweep already opened this case.
       * That is the index doing its job, not an error worth surfacing.
       */
    }
  }
  return opened;
}

/**
 * Work one case a single step forward.
 *
 * One step per sweep on purpose: recovery is a sequence with waits in it, and a
 * loop that ran a case to completion in one pass would send both messages
 * within a second of each other and call it two contacts.
 */
async function advanceCase(
  caseId: string,
  limits: RecoveryLimits,
  sessionId: string,
): Promise<{ acted: boolean; awaitingApproval: boolean; escalated: boolean; stopped: boolean; recoveredMinor: number }> {
  const idle = { acted: false, awaitingApproval: false, escalated: false, stopped: false, recoveredMinor: 0 };

  const [row] = await db.select().from(recoveryCases).where(eq(recoveryCases.id, caseId)).limit(1);
  if (!row) return idle;

  // ------------------------------------------------------------- VERIFY
  /*
   * Verification runs FIRST, before deciding anything.
   *
   * The commonest good outcome is a shopper who came back on their own, and an
   * agent that decided before checking would message someone who has already
   * paid — the single most embarrassing thing this system could do.
   */
  const verification =
    row.scenario === "abandoned_checkout" && row.cartId
      ? await verifyCartConverted(row.cartId, row.createdAt)
      : row.scenario === "payment_degradation"
        ? await verifyShopperPaying(row.userId, row.merchantId, row.createdAt)
        : row.orderId
          ? await verifyOrderPaid(row.orderId, row.createdAt)
          : { recovered: false as const, reason: "Nothing to verify against." };

  if (verification.recovered) {
    await db
      .update(recoveryCases)
      .set({
        state: "recovered",
        recoveredMinor: verification.amountMinor,
        recoveredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(recoveryCases.id, row.id));

    await record(sessionId, {
      step: "VERIFY",
      observation: { summary: verification.evidence },
      reasoning: { summary: "Revenue is counted only from a captured payment." },
      action: { type: "recovery_verify", params: { caseId: row.id } },
      outcome: { status: "ok", detail: `Recovered ${formatMoney(verification.amountMinor)}` },
    });
    return { ...idle, recoveredMinor: verification.amountMinor };
  }

  // Respect the wait. A case with a future `nextActionAt` is mid-cooldown.
  if (row.nextActionAt && row.nextActionAt > new Date()) return idle;

  // ---------------------------------------------------------- DETERMINE
  const diagnosis = (row.evidence as { diagnosis?: Diagnosis }).diagnosis;
  if (!diagnosis) return idle;

  /*
   * Age of the RISK, not of the case row.
   *
   * Read from the evidence the detector captured where it has it, so the first
   * sweep on an existing marketplace treats a week-old basket as a week old
   * rather than as something that just happened.
   */
  const evidence = row.evidence as { hoursSinceAbandoned?: number; orderPlacedAt?: string };
  const hoursAtRisk =
    evidence.hoursSinceAbandoned ??
    (evidence.orderPlacedAt
      ? (Date.now() - new Date(evidence.orderPlacedAt).getTime()) / 3_600_000
      : (Date.now() - row.createdAt.getTime()) / 3_600_000);
  const decision = determineAction(
    {
      diagnosis,
      amountAtRiskMinor: row.amountAtRiskMinor,
      retryCount: row.retryCount,
      messageCount: row.messageCount,
      incentiveMinor: row.incentiveMinor,
      hoursAtRisk,
      alreadyRecovered: false,
    },
    limits,
  );

  await record(sessionId, {
    step: "RECOMMEND",
    observation: {
      summary: `${formatMoney(row.amountAtRiskMinor)} at risk; ${row.messageCount} message(s) and ${row.retryCount} retry/retries so far.`,
    },
    reasoning: { summary: decision.rationale },
    action: { type: `recovery_${decision.action}`, params: { caseId: row.id } },
    outcome: { status: "ok", detail: decision.action },
  });

  // ------------------------------------------------------- terminal paths
  if (decision.action === "wait") {
    await db
      .update(recoveryCases)
      .set({
        nextActionAt: new Date(Date.now() + (decision.waitHours ?? 1) * 3_600_000),
        updatedAt: new Date(),
      })
      .where(eq(recoveryCases.id, row.id));
    return idle;
  }

  if (decision.action === "stop") {
    await db
      .update(recoveryCases)
      .set({ state: "stopped", stopReason: decision.stopReason ?? decision.rationale, updatedAt: new Date() })
      .where(eq(recoveryCases.id, row.id));
    return { ...idle, stopped: true };
  }

  if (decision.action === "escalate") {
    const escalation = await escalateToMerchant({
      merchantId: row.merchantId,
      userId: row.userId,
      orderId: row.orderId,
      amountAtRiskMinor: row.amountAtRiskMinor,
      reason: decision.stopReason ?? decision.rationale,
    });
    await db
      .update(recoveryCases)
      .set({ state: "escalated", stopReason: decision.stopReason ?? decision.rationale, updatedAt: new Date() })
      .where(eq(recoveryCases.id, row.id));

    await record(sessionId, {
      step: "EXECUTE",
      observation: { summary: escalation.detail },
      reasoning: { summary: "Handed to a person, with the reasoning attached." },
      action: { type: "recovery_escalate", params: { caseId: row.id } },
      outcome: { status: "ok", detail: escalation.detail },
    });
    return { ...idle, escalated: true };
  }

  // -------------------------------------------------------- POLICY CHECK
  /*
   * The gate. Nothing below this line happens without it.
   *
   * The decision above is a PROPOSAL; this is where a merchant's own limits
   * turn it into an action, an approval request, or a refusal.
   */
  const policyAction =
    decision.action === "incentive"
      ? ({
          type: "recovery_incentive" as const,
          bp: decision.discountBp ?? 0,
          amountMinor: decision.discountMinor ?? 0,
        })
      : decision.action === "retry_link"
        ? ({ type: "recovery_retry" as const, retriesSoFar: row.retryCount })
        : ({ type: "recovery_message" as const, messagesSoFar: row.messageCount });

  const policy = await evaluatePolicy(policyAction, { merchantId: row.merchantId });

  await record(sessionId, {
    step: "POLICY_CHECK",
    observation: { summary: policy.reason, inputs: { boundsChecked: policy.boundsChecked } },
    reasoning: { summary: "Deterministic bounds, not the agent's judgement." },
    action: { ...policyAction, verdict: policy.verdict },
    outcome: {
      status: policy.verdict === "DENY" ? "blocked" : "ok",
      detail: policy.violations.map((v) => v.message).join("; ") || policy.reason,
    },
  });

  if (policy.verdict === "DENY") {
    await db
      .update(recoveryCases)
      .set({
        state: "stopped",
        stopReason: `Blocked by policy: ${policy.violations.map((v) => v.message).join("; ") || policy.reason}`,
        updatedAt: new Date(),
      })
      .where(eq(recoveryCases.id, row.id));
    return { ...idle, stopped: true };
  }

  if (policy.verdict === "REQUIRE_APPROVAL") {
    const [merchant] = await db
      .select({ userId: merchants.userId })
      .from(merchants)
      .where(eq(merchants.id, row.merchantId))
      .limit(1);

    const [approval] = await db
      .insert(approvals)
      .values({
        sessionId,
        userId: merchant.userId,
        merchantId: row.merchantId,
        action: { ...policyAction, verdict: policy.verdict, requiresApproval: true },
        summary:
          decision.action === "incentive"
            ? `Offer ${formatMoney(decision.discountMinor ?? 0)} off to recover ${formatMoney(row.amountAtRiskMinor)}`
            : `Contact this shopper to recover ${formatMoney(row.amountAtRiskMinor)}`,
        verdict: policy.verdict,
        reason: policy.reason,
        expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
      })
      .returning();

    await db
      .update(recoveryCases)
      .set({ state: "awaiting_approval", approvalId: approval.id, updatedAt: new Date() })
      .where(eq(recoveryCases.id, row.id));
    return { ...idle, awaitingApproval: true };
  }

  // ----------------------------------------------------------------- ACT
  return runAction(row, decision, sessionId);
}

/** Executes an approved decision and records what actually happened. */
async function runAction(
  row: typeof recoveryCases.$inferSelect,
  decision: ReturnType<typeof determineAction>,
  sessionId: string,
) {
  const idle = { acted: false, awaitingApproval: false, escalated: false, stopped: false, recoveredMinor: 0 };

  const [merchant] = await db
    .select({ name: merchants.name })
    .from(merchants)
    .where(eq(merchants.id, row.merchantId))
    .limit(1);

  let code: string | undefined;
  let incentiveMinor = row.incentiveMinor;

  if (decision.action === "incentive") {
    const granted = await grantRecoveryIncentive({
      caseId: row.id,
      merchantId: row.merchantId,
      discountBp: decision.discountBp ?? 0,
      discountMinor: decision.discountMinor ?? 0,
      amountAtRiskMinor: row.amountAtRiskMinor,
    });
    if (!granted.ok) return idle;
    code = granted.detail.match(/BACK[A-Z0-9]+/)?.[0];
    incentiveMinor += decision.discountMinor ?? 0;
  }

  const { subject, body } = composeMessage({
    decision,
    scenario: row.scenario,
    amountAtRiskMinor: row.amountAtRiskMinor,
    merchantName: merchant?.name ?? "the seller",
    code,
    codeExpiresHours: code ? 72 : undefined,
    link: recoveryLink({ cartId: row.cartId, orderId: row.orderId }),
  });

  const sent = await sendRecoveryMessage({
    caseId: row.id,
    merchantId: row.merchantId,
    userId: row.userId,
    orderId: row.orderId,
    subject,
    body,
  });

  await db
    .update(recoveryCases)
    .set({
      state: "verifying",
      messageCount: row.messageCount + 1,
      retryCount: decision.action === "retry_link" ? row.retryCount + 1 : row.retryCount,
      incentiveMinor,
      // The cooldown before this case may be touched again.
      nextActionAt: new Date(Date.now() + 24 * 3_600_000),
      updatedAt: new Date(),
    })
    .where(eq(recoveryCases.id, row.id));

  await record(sessionId, {
    step: "EXECUTE",
    observation: { summary: sent.detail, inputs: { subject } },
    reasoning: { summary: decision.rationale },
    action: { type: `recovery_${decision.action}`, params: { caseId: row.id }, verdict: "ALLOW" },
    outcome: { status: sent.ok ? "ok" : "error", detail: sent.detail },
  });

  return { ...idle, acted: sent.ok };
}

/**
 * One full pass of the loop for a merchant.
 *
 * Safe to run repeatedly and safe to run often: detection skips subjects with
 * an open case, each case advances one step, and every case respects its own
 * cooldown. Running it twice in a minute does nothing the first run did not.
 */
export async function runRecoverySweep(input: {
  merchantId: string;
  userId: string;
}): Promise<SweepResult> {
  const session = await startSession({
    userId: input.userId,
    kind: "merchant",
    merchantId: input.merchantId,
    title: "Revenue recovery sweep",
  });

  const limits = await limitsFor(input.merchantId);
  const opened = await openCases(input.merchantId, session.id);

  const live = await db
    .select({ id: recoveryCases.id, amountAtRiskMinor: recoveryCases.amountAtRiskMinor })
    .from(recoveryCases)
    .where(
      and(
        eq(recoveryCases.merchantId, input.merchantId),
        inArray(recoveryCases.state, [...LIVE_STATES]),
      ),
    )
    .limit(100);

  /*
   * The blast radius of ONE run.
   *
   * Per-case limits bound how persistent the agent is with one shopper; they do
   * nothing about how many shoppers a single sweep reaches. Fifty cases each
   * inside their own two-message allowance is still fifty people contacted at
   * once — which is what happened in testing, twice, reaching 84 shoppers.
   *
   * Highest value first, so a bounded budget is spent where the money is rather
   * than on whatever the query returned first.
   */
  const alreadyContacted = await contactsToday(input.merchantId);
  let budget = Math.max(0, Math.min(limits.maxActionsPerSweep, limits.maxContactsPerDay - alreadyContacted));

  const totals = { acted: 0, awaitingApproval: 0, escalated: 0, stopped: 0, recoveredMinor: 0, deferred: 0 };
  for (const item of [...live].sort((a, b) => b.amountAtRiskMinor - a.amountAtRiskMinor)) {
    if (budget <= 0) {
      // Not dropped — left for the next sweep, with the risk still recorded.
      totals.deferred++;
      continue;
    }
    const outcome = await advanceCase(item.id, limits, session.id);
    if (outcome.acted || outcome.escalated) budget--;
    totals.acted += outcome.acted ? 1 : 0;
    totals.awaitingApproval += outcome.awaitingApproval ? 1 : 0;
    totals.escalated += outcome.escalated ? 1 : 0;
    totals.stopped += outcome.stopped ? 1 : 0;
    totals.recoveredMinor += outcome.recoveredMinor;
  }

  const atRisk = live.reduce((sum, c) => sum + c.amountAtRiskMinor, 0);

  await record(session.id, {
    step: "EXECUTE",
    observation: {
      summary:
        `Sweep complete: ${live.length} live case(s), ${formatMoney(atRisk)} at risk, ` +
        `${formatMoney(totals.recoveredMinor)} verified recovered` +
        (totals.deferred > 0
          ? `. ${totals.deferred} case(s) left for the next sweep — this run reached its contact budget.`
          : "."),
    },
    reasoning: { summary: "One step per case per sweep, with every bound checked before acting." },
    action: { type: "recovery_sweep" },
    outcome: { status: "ok", detail: `${totals.acted} acted, ${totals.stopped} stopped` },
  });

  return {
    merchantId: input.merchantId,
    detected: opened.length,
    atRiskMinor: atRisk,
    ...totals,
    cases: opened,
  };
}

/** What the merchant dashboard reports. Read from cases, not from claims. */
export async function recoveryMetrics(merchantId: string) {
  const [row] = (await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE state NOT IN ('recovered','stopped','escalated','expired')) AS open_cases,
      COALESCE(SUM(amount_at_risk_minor) FILTER (WHERE state NOT IN ('recovered','stopped','escalated','expired')), 0) AS at_risk_minor,
      COUNT(*) FILTER (WHERE state = 'recovered') AS recovered_cases,
      COALESCE(SUM(recovered_minor), 0) AS recovered_minor,
      COUNT(*) FILTER (WHERE state = 'escalated') AS escalated_cases,
      COUNT(*) FILTER (WHERE state = 'stopped') AS stopped_cases,
      COUNT(*) FILTER (WHERE state = 'awaiting_approval') AS awaiting_cases,
      COUNT(*) AS total_cases
    FROM recovery_cases
    WHERE merchant_id = ${merchantId}
  `)) as unknown as Record<string, unknown>[];

  const recoveredCases = Number(row.recovered_cases ?? 0);
  const closed = recoveredCases + Number(row.stopped_cases ?? 0) + Number(row.escalated_cases ?? 0);

  return {
    openCases: Number(row.open_cases ?? 0),
    atRiskMinor: Number(row.at_risk_minor ?? 0),
    recoveredCases,
    recoveredMinor: Number(row.recovered_minor ?? 0),
    escalatedCases: Number(row.escalated_cases ?? 0),
    stoppedCases: Number(row.stopped_cases ?? 0),
    awaitingCases: Number(row.awaiting_cases ?? 0),
    totalCases: Number(row.total_cases ?? 0),
    /** Of the cases that reached an end, how many ended in money. */
    recoveryRate: closed > 0 ? recoveredCases / closed : null,
  };
}
