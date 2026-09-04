import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { merchants, promotions, supportMessages, supportThreads } from "@/db/schema";
import { formatMoney } from "@/lib/money";
import type { RecoveryDecision } from "./determine";

/**
 * ACT — do the thing, through services that already exist.
 *
 * Two rules shape every function here.
 *
 * **Nothing is invented.** Outreach goes into the support threads this
 * marketplace already has, because that is a channel a shopper can actually
 * read and reply on. There is no email service, so the agent does not claim to
 * send email; an incentive is a real `promotions` row with a code the shopper
 * can actually use. A recovery step that logs "message sent" without a message
 * existing is worse than no recovery step, because the dashboard then reports
 * work that never happened.
 *
 * **Nothing charges a card.** There is no stored credential in this system, so
 * "retry the payment" cannot mean re-charging someone silently — and if it
 * could, doing it without them asking would be the wrong thing. A retry here is
 * a link back to the same basket at the same price, which the shopper chooses
 * to use. That is the honest version of the action, and it is the one the
 * `payments` table can verify.
 */

export type ActResult = {
  ok: boolean;
  /** What was actually done, in the words the case timeline will show. */
  detail: string;
  /** Set when the action created something a shopper can act on. */
  artefact?: { kind: "support_thread" | "promotion" | "recovery_link"; ref: string };
};

/** The link a shopper follows to finish what they started. */
export function recoveryLink(input: { cartId?: string | null; orderId?: string | null }): string {
  // Points at surfaces that already exist rather than a new landing page: the
  // cart is where an abandoned basket lives, and orders is where a failed
  // payment can be retried.
  return input.cartId ? `/cart` : `/orders`;
}

/**
 * Opens or continues one thread per case.
 *
 * One thread, not one per message: a shopper contacted twice about the same
 * basket should see a conversation, not two notifications that do not know
 * about each other. It is also what makes the message count on the case row
 * checkable against something a person can read.
 */
export async function sendRecoveryMessage(input: {
  caseId: string;
  merchantId: string;
  userId: string;
  orderId?: string | null;
  subject: string;
  body: string;
}): Promise<ActResult> {
  const [merchant] = await db
    .select({ id: merchants.id, userId: merchants.userId })
    .from(merchants)
    .where(eq(merchants.id, input.merchantId))
    .limit(1);
  if (!merchant) return { ok: false, detail: "That merchant no longer exists." };

  const [existing] = (await db.execute(sql`
    SELECT id FROM support_threads
    WHERE customer_id = ${input.userId}
      AND merchant_id = ${input.merchantId}
      AND subject = ${input.subject}
    LIMIT 1
  `)) as unknown as { id: string }[];

  const threadId =
    existing?.id ??
    (
      await db
        .insert(supportThreads)
        .values({
          customerId: input.userId,
          merchantId: input.merchantId,
          orderId: input.orderId ?? null,
          subject: input.subject,
        })
        .returning()
    )[0].id;

  await db.insert(supportMessages).values({
    threadId,
    // Attributed to the merchant, because it is sent on their behalf and under
    // their policy — the shopper is owed a real party to reply to.
    senderRole: "merchant",
    senderId: merchant.userId,
    body: input.body,
  });

  return {
    ok: true,
    detail: `Message sent to the shopper in their support thread.`,
    artefact: { kind: "support_thread", ref: threadId },
  };
}

/**
 * Creates a bounded, single-shopper, time-limited discount code.
 *
 * Bounded three ways on purpose. The VALUE is capped by the policy engine
 * before this is called. The SCOPE is this merchant only. And it EXPIRES,
 * because a recovery incentive that outlives the basket it was meant to rescue
 * becomes a standing discount the merchant never agreed to.
 */
export async function grantRecoveryIncentive(input: {
  caseId: string;
  merchantId: string;
  discountBp: number;
  discountMinor: number;
  amountAtRiskMinor: number;
  validHours?: number;
}): Promise<ActResult> {
  const validHours = input.validHours ?? 72;
  const code = `BACK${input.caseId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

  const [promotion] = await db
    .insert(promotions)
    .values({
      merchantId: input.merchantId,
      title: `Recovery offer — ${formatMoney(input.discountMinor)} off`,
      code,
      type: "flat_off",
      value: input.discountMinor,
      conditions: {
        // Never worth more than the basket it is rescuing.
        minSubtotalMinor: Math.max(input.discountMinor * 2, Math.round(input.amountAtRiskMinor / 2)),
      },
      active: true,
      activeFrom: new Date(),
      activeTo: new Date(Date.now() + validHours * 3_600_000),
      createdByAgent: true,
    })
    .returning();

  return {
    ok: true,
    detail:
      `Created ${code} — ${formatMoney(input.discountMinor)} off, ` +
      `expires in ${validHours}h, this seller only.`,
    artefact: { kind: "promotion", ref: promotion.id },
  };
}

/**
 * The words a shopper reads.
 *
 * Deterministic. A model could phrase these more warmly, but every sentence
 * here states a fact the case already holds — the basket, the amount, the code,
 * the expiry — and a generated version would be one more place for a claim to
 * appear that the system cannot back. The one thing recovery outreach must
 * never do is tell a shopper something untrue about their own money.
 */
export function composeMessage(input: {
  decision: RecoveryDecision;
  scenario: string;
  amountAtRiskMinor: number;
  merchantName: string;
  code?: string;
  codeExpiresHours?: number;
  link: string;
}): { subject: string; body: string } {
  const value = formatMoney(input.amountAtRiskMinor);

  if (input.scenario === "failed_payment") {
    return {
      subject: `Your ${value} order did not go through`,
      body:
        `Your payment of ${value} to ${input.merchantName} did not complete, so the order has not been placed ` +
        `and you have not been charged.\n\n` +
        `Everything is still held at the price you saw. You can finish it here: ${input.link}` +
        (input.code
          ? `\n\nUse ${input.code} at checkout for ${formatMoney(input.decision.discountMinor ?? 0)} off` +
            (input.codeExpiresHours ? ` — it expires in ${input.codeExpiresHours}h.` : ".")
          : ""),
    };
  }

  return {
    subject: `You left ${value} in your basket`,
    body:
      `Your basket with ${input.merchantName} is still here, holding ${value} of items at the price you saw.\n\n` +
      `Pick it up where you left off: ${input.link}` +
      (input.code
        ? `\n\nUse ${input.code} for ${formatMoney(input.decision.discountMinor ?? 0)} off` +
          (input.codeExpiresHours ? ` — it expires in ${input.codeExpiresHours}h.` : ".")
        : ""),
  };
}

/**
 * Hands a case to a person, with the reasoning attached.
 *
 * An escalation that just changes a status is a case nobody looks at. This puts
 * the agent's own reasoning in front of the merchant in the same support
 * surface they already read, so "the agent stopped and here is why" is a thing
 * they encounter rather than something they must go looking for.
 */
export async function escalateToMerchant(input: {
  merchantId: string;
  userId: string;
  orderId?: string | null;
  amountAtRiskMinor: number;
  reason: string;
}): Promise<ActResult> {
  const [merchant] = await db
    .select({ id: merchants.id, userId: merchants.userId })
    .from(merchants)
    .where(eq(merchants.id, input.merchantId))
    .limit(1);
  if (!merchant) return { ok: false, detail: "That merchant no longer exists." };

  const [thread] = await db
    .insert(supportThreads)
    .values({
      customerId: input.userId,
      merchantId: input.merchantId,
      orderId: input.orderId ?? null,
      subject: `Recovery needs a human — ${formatMoney(input.amountAtRiskMinor)} at risk`,
    })
    .returning();

  await db.insert(supportMessages).values({
    threadId: thread.id,
    // The channel only knows customer and merchant. An escalation is written
    // to the merchant as themselves, and says in its first line that it came
    // from the agent — rather than inventing a third sender the UI cannot show.
    senderRole: "merchant",
    senderId: merchant.userId,
    body:
      `Automated recovery stopped on ${formatMoney(input.amountAtRiskMinor)} of revenue.\n\n` +
      `${input.reason}\n\n` +
      `No further automated contact will be made about this. Anything from here is your call.`,
  });

  return {
    ok: true,
    detail: `Escalated to the merchant: ${input.reason}`,
    artefact: { kind: "support_thread", ref: thread.id },
  };
}
