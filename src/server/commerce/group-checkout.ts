import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  checkoutGroups,
  checkoutSessions,
  orders,
  payments,
  type Totals,
} from "@/db/schema";
import { formatMoney } from "@/lib/money";
import { record, startSession } from "@/server/audit/recorder";
import { evaluatePolicy } from "@/server/policy/engine";
import { commitStock, getOpenCarts, loadCart, markCartConverted } from "./cart";
import { authorizeCheckout, prepareCheckout, type CheckoutProposal } from "./checkout";
import { MockGateway, paymentGateway, type PaymentGateway } from "./gateway";

/**
 * One checkout across several merchants.
 *
 * Carts remain per-merchant, because everything downstream of the money is:
 * fulfilment, returns, support and the AP2 Cart Mandate, which a merchant can
 * only sign for their own basket. What the shopper should not have to repeat is
 * the *payment*. So the group is the settlement unit — one gateway order, one
 * approval gesture — over N orders that stay independently fulfillable.
 *
 * Concretely: N Cart Mandates (one per merchant, each properly signed), N
 * orders, ONE gateway order, and one payment row per order sharing its id so
 * each merchant still has their own settlement record.
 */

export type GroupLine = {
  proposal: CheckoutProposal;
  merchantName: string;
  merchantSlug: string;
};

export type GroupProposal = {
  status: "requires_authorization";
  groupId: string;
  totals: Totals;
  lines: GroupLine[];
  agentSessionId: string;
  limitsSummary: string[];
  /**
   * Baskets left OUT of this checkout, with the reason.
   *
   * Never silently dropped: a shopper who sees one combined total must be told
   * which of their merchants is not in it, or they will believe they have paid
   * for everything in the cart.
   */
  excluded: { merchantName: string; reason: string }[];
};

export type GroupBlocked = { status: "blocked"; reason: string; issues: string[] };
export type GroupPrepareResult = GroupProposal | GroupBlocked;

/** Sums per-merchant totals into the single figure the gateway is asked for. */
export function combineTotals(all: Totals[]): Totals {
  if (all.length === 0) {
    return {
      subtotalMinor: 0, discountMinor: 0, shippingMinor: 0,
      taxMinor: 0, totalMinor: 0, currency: "INR",
    };
  }
  // Shipping is NOT deduplicated: each merchant ships separately, so each one's
  // shipping is genuinely incurred. Presenting one combined total must not hide
  // that the shopper is paying it more than once.
  return {
    subtotalMinor: all.reduce((s, t) => s + t.subtotalMinor, 0),
    discountMinor: all.reduce((s, t) => s + t.discountMinor, 0),
    shippingMinor: all.reduce((s, t) => s + t.shippingMinor, 0),
    taxMinor: all.reduce((s, t) => s + t.taxMinor, 0),
    totalMinor: all.reduce((s, t) => s + t.totalMinor, 0),
    currency: all[0].currency,
  };
}

export async function prepareGroupCheckout(input: {
  userId: string;
  sessionId?: string;
  agentIdentifier?: string;
}): Promise<GroupPrepareResult> {
  const carts = await getOpenCarts(input.userId);
  if (carts.length === 0) {
    return { status: "blocked", reason: "Your cart is empty.", issues: [] };
  }

  const sessionId =
    input.sessionId ??
    (
      await startSession({
        userId: input.userId,
        kind: "customer",
        title: `Checkout across ${carts.length} merchant${carts.length === 1 ? "" : "s"}`,
      })
    ).id;

  const lines: GroupLine[] = [];
  const excluded: { merchantName: string; reason: string }[] = [];

  for (const cart of carts) {
    const proposal = await prepareCheckout({
      userId: input.userId,
      cartId: cart.cartId,
      sessionId,
      agentIdentifier: input.agentIdentifier,
    });

    if (proposal.status === "blocked") {
      // One unpayable basket must not silently drop out of a combined total.
      excluded.push({ merchantName: cart.merchant.name, reason: proposal.reason });
      continue;
    }
    lines.push({
      proposal,
      merchantName: cart.merchant.name,
      merchantSlug: cart.merchant.slug,
    });
  }

  if (lines.length === 0) {
    return {
      status: "blocked",
      reason: "None of your baskets can be checked out right now.",
      issues: excluded.map((e) => `${e.merchantName}: ${e.reason}`),
    };
  }

  const totals = combineTotals(lines.map((l) => l.proposal.totals));

  /*
   * Re-check the limits against the COMBINED total.
   *
   * Each basket was already checked on its own, but per-cart checks all measure
   * against the same "already committed today" figure, so three baskets that
   * individually fit the remaining headroom can exceed it together. Paying them
   * as one charge is exactly the case where that matters — without this, group
   * checkout would be a way to spend past a daily limit by splitting the basket
   * across merchants.
   */
  const groupVerdict = await evaluatePolicy(
    {
      type: "checkout",
      merchantId: lines[0].proposal.cart.merchant.id,
      totalMinor: totals.totalMinor,
      itemCount: lines.reduce(
        (sum, l) => sum + l.proposal.cart.lines.reduce((n, line) => n + line.quantity, 0),
        0,
      ),
    },
    { userId: input.userId },
  );

  if (groupVerdict.verdict === "DENY") {
    await record(sessionId, {
      step: "AUTHORIZE",
      observation: {
        summary: `Combined checkout of ${formatMoney(totals.totalMinor, totals.currency)} refused.`,
      },
      reasoning: {
        summary: "Each basket fits on its own; together they do not.",
        tradeoffs: groupVerdict.violations.map((v) => v.message).join("; "),
      },
      action: { type: "group_policy_check", verdict: "DENY" },
      outcome: { status: "blocked", detail: groupVerdict.reason },
    });
    return {
      status: "blocked",
      reason: groupVerdict.reason,
      issues: excluded.map((e) => `${e.merchantName}: ${e.reason}`),
    };
  }

  const [group] = await db
    .insert(checkoutGroups)
    .values({
      userId: input.userId,
      state: "open",
      totals,
      merchantCount: lines.length,
      agentSessionId: sessionId,
    })
    .returning();

  await record(sessionId, {
    step: "AUTHORIZE",
    observation: {
      summary:
        `Prepared one checkout covering ${lines.length} merchant${lines.length === 1 ? "" : "s"} ` +
        `for ${formatMoney(totals.totalMinor, totals.currency)}.`,
      inputs: { merchants: lines.map((l) => l.merchantSlug) },
    },
    reasoning: {
      summary:
        "Each merchant signs their own Cart Mandate; the shopper authorises once and pays once.",
      tradeoffs: excluded.length
        ? excluded.map((e) => `${e.merchantName}: ${e.reason}`).join("; ")
        : undefined,
    },
    action: { type: "prepare_group_checkout", verdict: "REQUIRE_APPROVAL", requiresApproval: true },
    outcome: { status: "ok", detail: group.id },
  });

  return {
    status: "requires_authorization",
    groupId: group.id,
    totals,
    lines,
    agentSessionId: sessionId,
    limitsSummary: lines.flatMap((l) => l.proposal.limitsSummary),
    excluded,
  };
}

export type GroupAuthorizeResult =
  | {
      status: "authorized";
      groupId: string;
      gatewayOrderId: string;
      gatewayKeyId: string | null;
      gateway: string;
      amountMinor: number;
      currency: string;
      orderIds: string[];
      orderNumbers: string[];
    }
  | { status: "rejected"; reason: string }
  | { status: "failed"; reason: string; checks?: string[] };

export async function authorizeGroupCheckout(input: {
  userId: string;
  groupId: string;
  approvalIds: string[];
  decision: "approve" | "reject";
  note?: string;
}): Promise<GroupAuthorizeResult> {
  const [group] = await db
    .select()
    .from(checkoutGroups)
    .where(and(eq(checkoutGroups.id, input.groupId), eq(checkoutGroups.userId, input.userId)))
    .limit(1);
  if (!group) return { status: "failed", reason: "That checkout was not found." };
  if (group.state !== "open") {
    return { status: "failed", reason: `This checkout was already ${group.state}.` };
  }

  const sessionId = group.agentSessionId ?? undefined;

  if (input.decision === "reject") {
    for (const approvalId of input.approvalIds) {
      await authorizeCheckout({ userId: input.userId, approvalId, decision: "reject", sessionId });
    }
    await db
      .update(checkoutGroups)
      .set({ state: "canceled", updatedAt: new Date() })
      .where(eq(checkoutGroups.id, group.id));
    return { status: "rejected", reason: "You declined this purchase. Nothing was charged." };
  }

  // ---- build every order first, with no gateway involvement at all ----
  const created: { orderId: string; orderNumber: string; amountMinor: number; mandateId: string }[] = [];

  for (const approvalId of input.approvalIds) {
    const result = await authorizeCheckout({
      userId: input.userId,
      approvalId,
      decision: "approve",
      sessionId,
      note: input.note,
      deferPayment: true,
      checkoutGroupId: group.id,
    });

    if (result.status !== "order_created") {
      // Any failure voids the whole group: a partial multi-merchant purchase is
      // worse than none, because the shopper approved them as one basket.
      await rollback(created.map((c) => c.orderId));
      await db
        .update(checkoutGroups)
        .set({ state: "failed", updatedAt: new Date() })
        .where(eq(checkoutGroups.id, group.id));
      return {
        status: "failed",
        reason: "reason" in result ? result.reason : "One basket could not be authorized.",
        checks: "checks" in result ? result.checks : undefined,
      };
    }

    created.push({
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      amountMinor: result.amountMinor,
      mandateId: result.paymentMandateId,
    });
  }

  const amountMinor = created.reduce((s, c) => s + c.amountMinor, 0);
  const currency = group.totals.currency;

  // ---- then ONE gateway order for the combined amount ----
  const gateway = paymentGateway();
  let gatewayOrder;
  try {
    gatewayOrder = await gateway.createOrder({
      amountMinor,
      currency,
      receipt: `GRP-${group.id.slice(0, 12)}`,
      notes: { groupId: group.id, orders: String(created.length) },
    });
  } catch (cause) {
    await rollback(created.map((c) => c.orderId));
    await db
      .update(checkoutGroups)
      .set({ state: "failed", updatedAt: new Date() })
      .where(eq(checkoutGroups.id, group.id));
    return { status: "failed", reason: `Payment could not be started: ${(cause as Error).message}` };
  }

  // One payment row per order, sharing the gateway order, so each merchant
  // keeps their own settlement record and refunds stay per-merchant.
  await db.insert(payments).values(
    created.map((c) => ({
      orderId: c.orderId,
      gateway: gateway.name,
      gatewayOrderId: gatewayOrder.gatewayOrderId,
      amountMinor: c.amountMinor,
      currency,
      state: "created" as const,
      paymentMandateId: c.mandateId,
      idempotencyKey: `group-${group.id}-${c.orderId}`,
    })),
  );

  await db
    .update(checkoutGroups)
    .set({ state: "authorized", gatewayOrderId: gatewayOrder.gatewayOrderId, updatedAt: new Date() })
    .where(eq(checkoutGroups.id, group.id));

  if (sessionId) {
    await record(sessionId, {
      step: "PAY",
      observation: {
        summary: `One gateway order for ${formatMoney(amountMinor, currency)} across ${created.length} merchants.`,
      },
      reasoning: { summary: "Shopper authorised once; each merchant's basket became its own order." },
      action: { type: "create_group_gateway_order", verdict: "ALLOW" },
      outcome: { status: "ok", detail: gatewayOrder.gatewayOrderId },
    });
  }

  return {
    status: "authorized",
    groupId: group.id,
    gatewayOrderId: gatewayOrder.gatewayOrderId,
    gatewayKeyId: gateway.publicKeyId(),
    gateway: gateway.name,
    amountMinor,
    currency,
    orderIds: created.map((c) => c.orderId),
    orderNumbers: created.map((c) => c.orderNumber),
  };
}

/** Marks already-created orders failed and returns their held stock. */
async function rollback(orderIds: string[]) {
  if (orderIds.length === 0) return;
  await db
    .update(orders)
    .set({ state: "payment_failed", updatedAt: new Date() })
    .where(inArray(orders.id, orderIds));

  const rows = await db
    .select({ checkoutSessionId: orders.checkoutSessionId })
    .from(orders)
    .where(inArray(orders.id, orderIds));

  for (const row of rows) {
    if (!row.checkoutSessionId) continue;
    const [session] = await db
      .select({ cartId: checkoutSessions.cartId })
      .from(checkoutSessions)
      .where(eq(checkoutSessions.id, row.checkoutSessionId))
      .limit(1);
    if (!session) continue;
    const cart = await loadCart(session.cartId).catch(() => null);
    if (cart?.lines.length) {
      const { releaseStock } = await import("./cart");
      await releaseStock(cart.lines);
    }
  }
}

export type GroupConfirmResult =
  | { status: "paid"; groupId: string; orderNumbers: string[] }
  | { status: "failed"; reason: string };

export async function confirmGroupPayment(input: {
  userId: string;
  groupId: string;
  gatewayPaymentId: string;
  signature: string;
  gateway?: PaymentGateway;
}): Promise<GroupConfirmResult> {
  const [group] = await db
    .select()
    .from(checkoutGroups)
    .where(and(eq(checkoutGroups.id, input.groupId), eq(checkoutGroups.userId, input.userId)))
    .limit(1);
  if (!group?.gatewayOrderId) return { status: "failed", reason: "That checkout was not found." };

  // Idempotent: a repeated confirmation is a no-op, never a second charge.
  if (group.state === "paid") {
    const paid = await db
      .select({ orderNumber: orders.orderNumber })
      .from(orders)
      .where(eq(orders.checkoutGroupId, group.id));
    return { status: "paid", groupId: group.id, orderNumbers: paid.map((o) => o.orderNumber) };
  }

  const gateway = input.gateway ?? paymentGateway();
  const verification = gateway.verifyPaymentSignature({
    gatewayOrderId: group.gatewayOrderId,
    gatewayPaymentId: input.gatewayPaymentId,
    signature: input.signature,
  });

  const groupOrders = await db.select().from(orders).where(eq(orders.checkoutGroupId, group.id));

  if (!verification.valid) {
    await db
      .update(payments)
      .set({ state: "failed", failureReason: verification.reason, updatedAt: new Date() })
      .where(eq(payments.gatewayOrderId, group.gatewayOrderId));
    await rollback(groupOrders.map((o) => o.id));
    await db
      .update(checkoutGroups)
      .set({ state: "failed", updatedAt: new Date() })
      .where(eq(checkoutGroups.id, group.id));
    return { status: "failed", reason: "Payment could not be verified. You have not been charged." };
  }

  // One signature covers the whole group, so every order settles together.
  await db
    .update(payments)
    .set({
      state: "captured",
      gatewayPaymentId: input.gatewayPaymentId,
      // The settling gateway, not the configured one — refunds read this.
      gateway: gateway.name,
      updatedAt: new Date(),
    })
    .where(eq(payments.gatewayOrderId, group.gatewayOrderId));

  await db
    .update(orders)
    .set({ state: "paid", updatedAt: new Date() })
    .where(eq(orders.checkoutGroupId, group.id));

  for (const order of groupOrders) {
    if (!order.checkoutSessionId) continue;
    const [session] = await db
      .select({ cartId: checkoutSessions.cartId })
      .from(checkoutSessions)
      .where(eq(checkoutSessions.id, order.checkoutSessionId))
      .limit(1);
    if (!session) continue;
    const cart = await loadCart(session.cartId).catch(() => null);
    if (cart?.lines.length) {
      await commitStock(cart.lines);
      await markCartConverted(cart.cartId);
    }
    await db
      .update(checkoutSessions)
      .set({ state: "completed", updatedAt: new Date() })
      .where(eq(checkoutSessions.id, order.checkoutSessionId));
  }

  await db
    .update(checkoutGroups)
    .set({ state: "paid", updatedAt: new Date() })
    .where(eq(checkoutGroups.id, group.id));

  if (group.agentSessionId) {
    await record(group.agentSessionId, {
      step: "CONFIRM",
      observation: {
        summary: `Captured ${formatMoney(group.totals.totalMinor, group.totals.currency)} across ${groupOrders.length} orders.`,
      },
      reasoning: { summary: "One signature verified; every order in the group settled together." },
      action: { type: "confirm_group_payment", verdict: "ALLOW" },
      outcome: { status: "ok", detail: input.gatewayPaymentId },
    });
  }

  return {
    status: "paid",
    groupId: group.id,
    orderNumbers: groupOrders.map((o) => o.orderNumber),
  };
}


/**
 * Agent-driven settlement, with a truthful step log.
 *
 * The shopper watches the agent pay rather than paying themselves. Each entry
 * in `steps` is appended AFTER the work it describes actually succeeded, so the
 * timeline is a record, not an animation — if the signature check fails, the
 * step log stops there and says so.
 *
 * Settlement runs through `MockGateway` for the same reason saved-method
 * purchases do: Razorpay test mode cannot charge a stored instrument
 * server-side without real tokenisation (see the payments notes in NOTES.md).
 * The shopper is told this rather than shown a fake card form.
 */
export type AgentPayStep = {
  label: string;
  detail: string;
  status: "ok" | "failed";
};

export type GroupAgentPayResult =
  | { status: "paid"; groupId: string; orderNumbers: string[]; steps: AgentPayStep[] }
  | { status: "failed"; reason: string; steps: AgentPayStep[] };

export async function payGroupAsAgent(input: {
  userId: string;
  groupId: string;
}): Promise<GroupAgentPayResult> {
  const steps: AgentPayStep[] = [];
  const fail = (reason: string, label: string): GroupAgentPayResult => {
    steps.push({ label, detail: reason, status: "failed" });
    return { status: "failed", reason, steps };
  };

  const [group] = await db
    .select()
    .from(checkoutGroups)
    .where(and(eq(checkoutGroups.id, input.groupId), eq(checkoutGroups.userId, input.userId)))
    .limit(1);
  if (!group?.gatewayOrderId) {
    return fail("That checkout was not found.", "Locating the authorised checkout");
  }

  const groupOrders = await db.select().from(orders).where(eq(orders.checkoutGroupId, group.id));
  steps.push({
    label: "Located the authorised checkout",
    detail: `${groupOrders.length} order${groupOrders.length === 1 ? "" : "s"} · gateway order ${group.gatewayOrderId}`,
    status: "ok",
  });

  const gateway = new MockGateway();
  const gatewayPaymentId = `pay_agent_${group.id.slice(0, 8)}_${Date.now().toString(36)}`;
  steps.push({
    label: "Submitted the payment instrument",
    detail: `Settled through ${gateway.name} — Razorpay test mode cannot charge a stored card server-side.`,
    status: "ok",
  });

  const signature = MockGateway.sign(group.gatewayOrderId, gatewayPaymentId);
  steps.push({
    label: "Gateway returned a signed result",
    detail: `Payment ${gatewayPaymentId}`,
    status: "ok",
  });

  const confirmed = await confirmGroupPayment({
    userId: input.userId,
    groupId: group.id,
    gatewayPaymentId,
    signature,
    gateway,
  });

  if (confirmed.status !== "paid") {
    return fail(confirmed.reason, "Verifying the gateway signature");
  }

  steps.push({
    label: "Verified the signature and mandate chain",
    detail: "Signature matched the gateway order; nothing was charged before this passed.",
    status: "ok",
  });
  steps.push({
    label: "Committed stock and settled every order",
    detail: confirmed.orderNumbers.join(", "),
    status: "ok",
  });

  return {
    status: "paid",
    groupId: group.id,
    orderNumbers: confirmed.orderNumbers,
    steps,
  };
}
