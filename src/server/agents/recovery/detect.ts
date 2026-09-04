import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * DETECT — find revenue that is at risk, and find it the same way twice.
 *
 * Deliberately plain SQL with no model anywhere near it. Detection decides
 * which shoppers get contacted, and a stage that returned slightly different
 * answers on two runs would message some of them twice and miss others
 * entirely.
 *
 * **Every query excludes subjects that have EVER had a case**, and the database
 * enforces the same thing with a unique index. Two layers, because the cost of
 * losing this is not a duplicate row — it is a shopper contacted twice and
 * revenue counted twice on the merchant's dashboard.
 *
 * Scoping that exclusion to OPEN cases was the first version and it was wrong:
 * an escalated case stopped colliding, so the next sweep re-detected the same
 * failed payment. Three passes produced thirteen cases for five risks and
 * twelve escalation threads. An escalated case has an owner and an outcome.
 */

export type DetectedCase = {
  scenario: "failed_payment" | "abandoned_checkout" | "payment_degradation";
  merchantId: string;
  userId: string;
  orderId?: string;
  cartId?: string;
  paymentId?: string;
  amountAtRiskMinor: number;
  currency: string;
  /** Everything the diagnosis stage will need, gathered once. */
  evidence: Record<string, unknown>;
};

/** A basket left this long is treated as abandoned rather than in progress. */
const ABANDONED_AFTER_HOURS = 1;

/** Beyond this there is no point contacting anyone; the moment has passed. */
const TOO_OLD_HOURS = 24 * 14;

/** Failures inside this window count toward "this keeps happening". */
const DEGRADATION_WINDOW_HOURS = 72;
const DEGRADATION_THRESHOLD = 3;

/**
 * A. FAILED PAYMENT — the charge was attempted and did not succeed.
 *
 * Scoped to orders still owed: an order that later reached `paid` recovered
 * itself and is not at risk, and one that was cancelled or refunded is settled.
 */
export async function detectFailedPayments(merchantId: string): Promise<DetectedCase[]> {
  const rows = (await db.execute(sql`
    SELECT o.id AS order_id, o.user_id, o.merchant_id, o.totals, o.created_at,
           p.id AS payment_id, p.failure_reason, p.amount_minor, p.currency,
           (
             SELECT COUNT(*) FROM payments p2
             JOIN orders o2 ON o2.id = p2.order_id
             WHERE o2.user_id = o.user_id
               AND p2.state = 'failed'
               AND p2.created_at > now() - interval '${sql.raw(String(DEGRADATION_WINDOW_HOURS))} hours'
           ) AS recent_failures
    FROM orders o
    JOIN payments p ON p.order_id = o.id
    WHERE o.merchant_id = ${merchantId}
      AND p.state = 'failed'
      AND o.state IN ('pending_payment', 'payment_failed')
      AND o.created_at > now() - interval '${sql.raw(String(TOO_OLD_HOURS))} hours'
      -- Nothing that already recovered on its own.
      AND NOT EXISTS (
        SELECT 1 FROM payments ok WHERE ok.order_id = o.id AND ok.state = 'captured'
      )
      -- Nothing that has EVER had a case. An escalated or stopped case has an
      -- owner and an outcome; re-detecting it is spam with a fresh row id.
      AND NOT EXISTS (SELECT 1 FROM recovery_cases rc WHERE rc.order_id = o.id)
    ORDER BY p.amount_minor DESC
    LIMIT 50
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    scenario: "failed_payment" as const,
    merchantId: String(r.merchant_id),
    userId: String(r.user_id),
    orderId: String(r.order_id),
    paymentId: String(r.payment_id),
    amountAtRiskMinor: Number(r.amount_minor),
    currency: String(r.currency ?? "INR"),
    evidence: {
      failureReason: r.failure_reason ?? null,
      recentFailureCount: Number(r.recent_failures ?? 0),
      orderPlacedAt: r.created_at,
    },
  }));
}

/**
 * B. ABANDONED CHECKOUT — a basket with real items that never became an order.
 *
 * `paymentAttempted` is the one thing the evidence genuinely distinguishes, and
 * it is read from whether a checkout session ever reached the authorization
 * step. Everything past that — price, postage, second thoughts — is invisible
 * here, and the diagnosis stage is careful not to pretend otherwise.
 */
export async function detectAbandonedCheckouts(merchantId: string): Promise<DetectedCase[]> {
  const rows = (await db.execute(sql`
    SELECT c.id AS cart_id, c.user_id, c.merchant_id, c.currency, c.updated_at,
           SUM(ci.quantity * ci.unit_price_minor) AS value_minor,
           COUNT(ci.id) AS item_count,
           EXISTS (
             SELECT 1 FROM checkout_sessions cs
             WHERE cs.cart_id = c.id
               AND cs.state IN ('requires_authorization','failed')
           ) AS payment_attempted,
           (
             SELECT COUNT(*) FROM carts c2
             WHERE c2.user_id = c.user_id AND c2.merchant_id = c.merchant_id
               AND c2.status = 'abandoned'
           ) AS prior_abandonments,
           EXTRACT(EPOCH FROM (now() - c.updated_at)) / 3600 AS hours_since
    FROM carts c
    JOIN cart_items ci ON ci.cart_id = c.id
    WHERE c.merchant_id = ${merchantId}
      AND c.status = 'open'
      AND c.updated_at < now() - interval '${sql.raw(String(ABANDONED_AFTER_HOURS))} hours'
      AND c.updated_at > now() - interval '${sql.raw(String(TOO_OLD_HOURS))} hours'
      -- A basket that became an order is not abandoned.
      AND NOT EXISTS (
        SELECT 1 FROM orders o
        JOIN checkout_sessions cs2 ON cs2.id = o.checkout_session_id
        WHERE cs2.cart_id = c.id
      )
      AND NOT EXISTS (SELECT 1 FROM recovery_cases rc WHERE rc.cart_id = c.id)
    GROUP BY c.id, c.user_id, c.merchant_id, c.currency, c.updated_at
    ORDER BY SUM(ci.quantity * ci.unit_price_minor) DESC
    LIMIT 50
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    scenario: "abandoned_checkout" as const,
    merchantId: String(r.merchant_id),
    userId: String(r.user_id),
    cartId: String(r.cart_id),
    amountAtRiskMinor: Number(r.value_minor),
    currency: String(r.currency ?? "INR"),
    evidence: {
      paymentAttempted: Boolean(r.payment_attempted),
      hoursSinceAbandoned: Number(r.hours_since ?? 0),
      priorAbandonments: Number(r.prior_abandonments ?? 0),
      itemCount: Number(r.item_count ?? 0),
    },
  }));
}

/**
 * C. PAYMENT DEGRADATION — this shopper's payments keep failing.
 *
 * The subject is the SHOPPER, not any one order, which is what makes it a
 * different case from A rather than several of them. It exists so the agent can
 * see the pattern and stop, instead of cheerfully working three failed orders
 * in parallel and contacting the same person three times.
 */
export async function detectPaymentDegradation(merchantId: string): Promise<DetectedCase[]> {
  const rows = (await db.execute(sql`
    SELECT o.user_id, o.merchant_id,
           COUNT(*) AS failure_count,
           COUNT(DISTINCT o.id) AS distinct_orders,
           SUM(p.amount_minor) AS value_minor,
           MAX(p.currency) AS currency
    FROM payments p
    JOIN orders o ON o.id = p.order_id
    WHERE o.merchant_id = ${merchantId}
      AND p.state = 'failed'
      AND p.created_at > now() - interval '${sql.raw(String(DEGRADATION_WINDOW_HOURS))} hours'
      /*
       * Degradation is about the shopper rather than an order, so it CAN
       * legitimately recur — a card fixed in March may fail again in June. A
       * cooldown rather than a permanent bar, so the same bad fortnight does
       * not open a second case while the first is still being dealt with.
       */
      AND NOT EXISTS (
        SELECT 1 FROM recovery_cases rc
        WHERE rc.user_id = o.user_id
          AND rc.merchant_id = o.merchant_id
          AND rc.scenario = 'payment_degradation'
          AND rc.created_at > now() - interval '30 days'
      )
    GROUP BY o.user_id, o.merchant_id
    HAVING COUNT(*) >= ${DEGRADATION_THRESHOLD}
    LIMIT 20
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    scenario: "payment_degradation" as const,
    merchantId: String(r.merchant_id),
    userId: String(r.user_id),
    amountAtRiskMinor: Number(r.value_minor),
    currency: String(r.currency ?? "INR"),
    evidence: {
      failureCount: Number(r.failure_count),
      distinctOrders: Number(r.distinct_orders),
      windowHours: DEGRADATION_WINDOW_HOURS,
    },
  }));
}

/**
 * Everything at risk for one merchant, largest first.
 *
 * Degradation is detected BEFORE the individual failures it is made of, so a
 * shopper whose card is dead becomes one case with one decision rather than
 * three cases racing to contact them.
 */
export async function detectAll(merchantId: string): Promise<DetectedCase[]> {
  const [degradation, failures, abandoned] = await Promise.all([
    detectPaymentDegradation(merchantId),
    detectFailedPayments(merchantId),
    detectAbandonedCheckouts(merchantId),
  ]);

  const degradedShoppers = new Set(degradation.map((c) => c.userId));

  return [
    ...degradation,
    // A shopper already covered by a degradation case is not worked twice.
    ...failures.filter((c) => !degradedShoppers.has(c.userId)),
    ...abandoned.filter((c) => !degradedShoppers.has(c.userId)),
  ];
}
