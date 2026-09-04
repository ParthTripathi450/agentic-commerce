import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * VERIFY — did the money actually arrive?
 *
 * The stage that makes "revenue recovered" a fact rather than a claim. An agent
 * that counted a sent message as a recovery would report a number that is
 * entirely under its own control, which is the failure mode of every
 * recovery dashboard that has ever flattered itself.
 *
 * So recovery is only ever read from a **captured payment** — the same row the
 * ledger and the merchant's own payouts are built on. Not an order state, which
 * can move for other reasons; not a click; not a returned visit.
 */

export type VerifyResult =
  | { recovered: true; amountMinor: number; evidence: string }
  | { recovered: false; reason: string };

/**
 * Did this order get paid after the case was opened?
 *
 * The `since` bound is what makes the attribution honest. Without it, a case
 * opened on an order that had already been paid would report the original
 * payment as recovered revenue — money that was never at risk.
 */
export async function verifyOrderPaid(orderId: string, since: Date): Promise<VerifyResult> {
  const rows = (await db.execute(sql`
    SELECT p.amount_minor, p.currency, p.updated_at, o.state AS order_state
    FROM payments p
    JOIN orders o ON o.id = p.order_id
    WHERE p.order_id = ${orderId}
      AND p.state = 'captured'
      AND p.updated_at >= ${since.toISOString()}
    ORDER BY p.updated_at DESC
    LIMIT 1
  `)) as unknown as Record<string, unknown>[];

  const paid = rows[0];
  if (!paid) return { recovered: false, reason: "No captured payment on this order yet." };

  return {
    recovered: true,
    amountMinor: Number(paid.amount_minor),
    evidence: `Payment captured at ${new Date(String(paid.updated_at)).toISOString()}; order is ${paid.order_state}.`,
  };
}

/**
 * Did this abandoned basket turn into a paid order?
 *
 * Followed through the checkout session rather than by matching amounts: a
 * shopper who comes back and buys the same thing at a different quantity has
 * still been recovered, and one who buys something unrelated has not. The
 * session is the only link that actually says "this basket became that order".
 */
export async function verifyCartConverted(cartId: string, since: Date): Promise<VerifyResult> {
  const rows = (await db.execute(sql`
    SELECT p.amount_minor, o.order_number, p.updated_at
    FROM checkout_sessions cs
    JOIN orders o ON o.checkout_session_id = cs.id
    JOIN payments p ON p.order_id = o.id
    WHERE cs.cart_id = ${cartId}
      AND p.state = 'captured'
      AND p.updated_at >= ${since.toISOString()}
    ORDER BY p.updated_at DESC
    LIMIT 1
  `)) as unknown as Record<string, unknown>[];

  const paid = rows[0];
  if (!paid) return { recovered: false, reason: "That basket has not been paid for." };

  return {
    recovered: true,
    amountMinor: Number(paid.amount_minor),
    evidence: `Basket became order ${paid.order_number}, captured at ${new Date(String(paid.updated_at)).toISOString()}.`,
  };
}

/**
 * Has this shopper managed to pay this merchant at all since the case opened?
 *
 * The right question for a degradation case, where the subject is the shopper
 * rather than any one order: their next successful payment is the evidence the
 * problem has cleared, whichever basket it happens to be for.
 */
export async function verifyShopperPaying(
  userId: string,
  merchantId: string,
  since: Date,
): Promise<VerifyResult> {
  const rows = (await db.execute(sql`
    SELECT p.amount_minor, p.updated_at
    FROM payments p
    JOIN orders o ON o.id = p.order_id
    WHERE o.user_id = ${userId}
      AND o.merchant_id = ${merchantId}
      AND p.state = 'captured'
      AND p.updated_at >= ${since.toISOString()}
    ORDER BY p.updated_at DESC
    LIMIT 1
  `)) as unknown as Record<string, unknown>[];

  const paid = rows[0];
  if (!paid) return { recovered: false, reason: "This shopper has not completed a payment since." };

  return {
    recovered: true,
    amountMinor: Number(paid.amount_minor),
    evidence: `Shopper paid this merchant successfully at ${new Date(String(paid.updated_at)).toISOString()}.`,
  };
}
