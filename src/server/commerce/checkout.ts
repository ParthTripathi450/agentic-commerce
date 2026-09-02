import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  approvals,
  checkoutSessions,
  orderItems,
  orders,
  payments,
  type Totals,
} from "@/db/schema";
import { formatMoney } from "@/lib/money";
import { record, startSession } from "@/server/audit/recorder";
import { evaluatePolicy } from "@/server/policy/engine";
import {
  consumeMandate,
  createCartMandate,
  createIntentMandate,
  createPaymentMandate,
  verifyMandateChain,
} from "@/server/protocols/ap2/mandates";
import {
  commitStock,
  discardAgentCart,
  loadCart,
  markCartConverted,
  releaseStock,
  reserveStock,
  type CartView,
} from "./cart";
import { releaseExpiredCheckouts } from "./expiry";
import { paymentGateway, type PaymentGateway } from "./gateway";

/**
 * Checkout: cart → policy → mandates → human authorization → payment → order.
 *
 * Nothing here charges money on its own. `prepareCheckout` gets as far as a
 * signed, verifiable proposal and then stops; only an explicit approval turns
 * that into a payment. Every outcome — including refusals — is audited.
 */

export type CheckoutBlocked = {
  status: "blocked";
  reason: string;
  issues: string[];
  verdict: "DENY";
};

export type CheckoutProposal = {
  status: "requires_authorization";
  checkoutSessionId: string;
  approvalId: string;
  cartMandateId: string;
  intentMandateId: string;
  cart: CartView;
  totals: Totals;
  reason: string;
  limitsSummary: string[];
  /** Audit session for this purchase; passed to authorize/confirm. */
  agentSessionId: string;
};

export type PrepareResult = CheckoutBlocked | CheckoutProposal;

const SESSION_TTL_MINUTES = 30;

/**
 * Builds an authorizable checkout proposal. Deliberately stops short of paying.
 */
export async function prepareCheckout(input: {
  userId: string;
  cartId: string;
  sessionId?: string;
  intentText?: string;
  intentMandateId?: string;
  promoCode?: string;
  agentIdentifier?: string;
}): Promise<PrepareResult> {
  // Reclaim stock held by checkouts nobody ever completed, so an abandoned
  // proposal cannot make an item look permanently sold out.
  await releaseExpiredCheckouts();

  const cart = await loadCart(input.cartId, input.promoCode);

  // Money must always be auditable, even when no shopping agent was involved
  // (direct API call, MCP client, or a shopper checking out by hand).
  const sessionId =
    input.sessionId ??
    (
      await startSession({
        userId: input.userId,
        kind: "customer",
        title: `Checkout at ${cart.merchant.name}`,
      })
    ).id;

  const audit = async (
    step: "CART" | "POLICY_CHECK",
    summary: string,
    outcome: Parameters<typeof record>[1]["outcome"],
    extra?: Partial<Parameters<typeof record>[1]>,
  ) => {
    
    await record(sessionId, {
      step,
      observation: { summary, inputs: { cartId: input.cartId, totals: cart.totals } },
      reasoning: { summary },
      action: { type: step.toLowerCase() },
      outcome,
      ...extra,
    });
  };

  if (cart.lines.length === 0) {
    const reason = "Your cart is empty.";
    await audit("CART", reason, { status: "blocked", detail: reason });
    return { status: "blocked", reason, issues: [], verdict: "DENY" };
  }

  // Stock or price problems must be resolved before anything is signed.
  const blocking = cart.issues.filter((i) => i.kind !== "price_changed");
  if (blocking.length > 0) {
    const reason = "Some items are no longer available.";
    await audit("CART", reason, {
      status: "blocked",
      detail: blocking.map((i) => i.detail).join(" "),
    });
    return { status: "blocked", reason, issues: blocking.map((i) => i.detail), verdict: "DENY" };
  }

  const itemCount = cart.lines.reduce((sum, l) => sum + l.quantity, 0);
  const decision = await evaluatePolicy(
    {
      type: "checkout",
      merchantId: cart.merchant.id,
      totalMinor: cart.totals.totalMinor,
      itemCount,
    },
    { userId: input.userId, merchantId: cart.merchant.id },
  );

  {
    await record(sessionId, {
      step: "POLICY_CHECK",
      observation: {
        summary: `Checked ${formatMoney(cart.totals.totalMinor)} checkout against spending limits.`,
        inputs: { totals: cart.totals, itemCount },
      },
      reasoning: {
        summary: decision.reason,
        tradeoffs: decision.violations.map((v) => v.message).join("; ") || undefined,
      },
      action: {
        type: "checkout",
        verdict: decision.verdict,
        boundsChecked: decision.boundsChecked,
        requiresApproval: decision.verdict === "REQUIRE_APPROVAL",
      },
      outcome: {
        status: decision.verdict === "DENY" ? "blocked" : "ok",
        detail: decision.reason,
      },
    });
  }

  if (decision.verdict === "DENY") {
    return {
      status: "blocked",
      reason: decision.reason,
      issues: decision.violations.map((v) => v.message),
      verdict: "DENY",
    };
  }

  // Hold stock only once the purchase is genuinely proposable.
  const reservation = await reserveStock(cart.lines);
  if (!reservation.ok) {
    await audit("CART", reservation.failure!, { status: "blocked", detail: reservation.failure });
    return { status: "blocked", reason: reservation.failure!, issues: [], verdict: "DENY" };
  }

  try {
    const intentMandate = input.intentMandateId
      ? { id: input.intentMandateId }
      : await createIntentMandate({
          userId: input.userId,
          sessionId,
          naturalLanguageIntent: input.intentText ?? `Purchase from ${cart.merchant.name}`,
          maxAmountMinor: cart.totals.totalMinor,
          allowedMerchantIds: [cart.merchant.id],
        });

    const cartMandate = await createCartMandate({
      userId: input.userId,
      merchantId: cart.merchant.id,
      merchantSlug: cart.merchant.slug,
      sessionId,
      intentMandateId: intentMandate.id,
      items: cart.lines.map((line) => ({
        variantId: line.variantId,
        sku: line.sku,
        title: line.title,
        attributes: line.attributes,
        quantity: line.quantity,
        unitPriceMinor: line.currentPriceMinor,
      })),
      totals: cart.totals,
    });

    const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60_000);
    const [session] = await db
      .insert(checkoutSessions)
      .values({
        cartId: cart.cartId,
        merchantId: cart.merchant.id,
        userId: input.userId,
        state: "requires_authorization",
        totals: cart.totals,
        agentIdentifier: input.agentIdentifier ?? null,
        idempotencyKey: randomUUID(),
        appliedPromotionId: cart.appliedPromotion?.id ?? null,
        expiresAt,
      })
      .returning();

    const summary =
      `Pay ${formatMoney(cart.totals.totalMinor)} to ${cart.merchant.name} for ` +
      cart.lines.map((l) => `${l.quantity}× ${l.title}`).join(", ");

    const [approval] = await db
      .insert(approvals)
      .values({
        sessionId,
        userId: input.userId,
        merchantId: cart.merchant.id,
        action: {
          type: "pay",
          params: {
            checkoutSessionId: session.id,
            cartMandateId: cartMandate.id,
            amountMinor: cart.totals.totalMinor,
          },
          verdict: decision.verdict,
          boundsChecked: decision.boundsChecked,
          requiresApproval: true,
          mandateId: cartMandate.id,
        },
        summary,
        verdict: decision.verdict,
        reason: decision.reason,
        expiresAt,
      })
      .returning();

    return {
      status: "requires_authorization",
      checkoutSessionId: session.id,
      approvalId: approval.id,
      cartMandateId: cartMandate.id,
      intentMandateId: intentMandate.id,
      cart,
      totals: cart.totals,
      reason: decision.reason,
      agentSessionId: sessionId,
      limitsSummary: [
        decision.limits.maxOrderValueMinor
          ? `Per-order limit ${formatMoney(decision.limits.maxOrderValueMinor)}`
          : null,
        decision.limits.maxDailySpendMinor
          ? `Daily limit ${formatMoney(decision.limits.maxDailySpendMinor)}`
          : null,
        `Checks applied: ${decision.boundsChecked.join(", ") || "none"}`,
      ].filter((v): v is string => Boolean(v)),
    };
  } catch (error) {
    await releaseStock(cart.lines); // never leave stock held by a failed proposal
    throw error;
  }
}

export type AuthorizeResult =
  | {
      status: "authorized";
      orderId: string;
      orderNumber: string;
      paymentId: string;
      gatewayOrderId: string;
      gatewayKeyId: string | null;
      gateway: string;
      amountMinor: number;
      currency: string;
      paymentMandateId: string;
    }
  /**
   * Order created, payment deliberately not started.
   *
   * Returned only when `deferPayment` is set, which is how a multi-merchant
   * group checkout builds N orders and then settles them with ONE gateway
   * order instead of N.
   */
  | {
      status: "order_created";
      orderId: string;
      orderNumber: string;
      amountMinor: number;
      currency: string;
      paymentMandateId: string;
      agentSessionId: string;
    }
  | { status: "rejected"; reason: string }
  | { status: "failed"; reason: string; checks?: string[] };

/**
 * Turns an approved proposal into a real, payable order.
 *
 * The mandate chain is verified here — after the shopper approved, immediately
 * before money is requested — so a cart edited in between is caught.
 */
export async function authorizeCheckout(input: {
  userId: string;
  approvalId: string;
  decision: "approve" | "reject";
  sessionId?: string;
  note?: string;
  /**
   * Stop after the order exists, leaving the caller to create the gateway
   * order and payment rows. Used by group checkout so several merchants'
   * orders share a single charge.
   */
  deferPayment?: boolean;
  /** Stamped on the order so its group can be found later. */
  checkoutGroupId?: string;
}): Promise<AuthorizeResult> {
  const [approval] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, input.approvalId), eq(approvals.userId, input.userId)))
    .limit(1);

  if (!approval) return { status: "failed", reason: "That authorization request was not found." };
  if (approval.status !== "pending") {
    return { status: "failed", reason: `This request was already ${approval.status}.` };
  }
  if (approval.expiresAt < new Date()) {
    await db.update(approvals).set({ status: "expired" }).where(eq(approvals.id, approval.id));
    return { status: "failed", reason: "This authorization expired. Please start checkout again." };
  }

  // Continue the audit trail the proposal opened, rather than starting a new one.
  const sessionId =
    input.sessionId ??
    approval.sessionId ??
    (
      await startSession({
        userId: input.userId,
        kind: "customer",
        title: `Authorization ${approval.id.slice(0, 8)}`,
      })
    ).id;

  const params = approval.action.params as {
    checkoutSessionId: string;
    cartMandateId: string;
    amountMinor: number;
  };

  const [session] = await db
    .select()
    .from(checkoutSessions)
    .where(eq(checkoutSessions.id, params.checkoutSessionId))
    .limit(1);
  if (!session) return { status: "failed", reason: "Checkout session no longer exists." };

  const cart = await loadCart(session.cartId);

  if (input.decision === "reject") {
    await db
      .update(approvals)
      .set({ status: "rejected", decidedBy: input.userId, decidedAt: new Date(), decisionNote: input.note })
      .where(eq(approvals.id, approval.id));
    await db
      .update(checkoutSessions)
      .set({ state: "canceled", updatedAt: new Date() })
      .where(eq(checkoutSessions.id, session.id));
    await releaseStock(cart.lines);

    // A basket the AGENT assembled and the shopper declined should not linger
    // in their cart. One they built themselves survives — they chose to put it
    // there, and declining a payment is not the same as changing their mind.
    const discarded = await discardAgentCart(cart.cartId);

    if (input.sessionId) {
      await record(sessionId, {
        step: "AUTHORIZE",
        observation: {
          summary: `Shopper declined: ${approval.summary}`,
          inputs: { agentCartDiscarded: discarded },
        },
        reasoning: { summary: "Authorization refused by the shopper. No money moved." },
        action: { type: "pay", approvalId: approval.id, verdict: "DENY" },
        outcome: { status: "blocked", detail: "declined by shopper" },
      });
    }
    return { status: "rejected", reason: "You declined this payment. Nothing was charged." };
  }

  // Approved — now bind a Payment Mandate and verify the whole chain.
  const paymentMandate = await createPaymentMandate({
    userId: input.userId,
    merchantId: session.merchantId,
    sessionId,
    cartMandateId: params.cartMandateId,
    amountMinor: cart.totals.totalMinor,
    currency: cart.totals.currency,
  });

  const verification = await verifyMandateChain(paymentMandate.id);
  if (!verification.valid) {
    await db
      .update(checkoutSessions)
      .set({ state: "failed", updatedAt: new Date() })
      .where(eq(checkoutSessions.id, session.id));
    await releaseStock(cart.lines);

    if (input.sessionId) {
      await record(sessionId, {
        step: "MANDATE",
        observation: { summary: "Verified the AP2 mandate chain before charging." },
        reasoning: {
          summary: "Chain verification FAILED — refusing to charge.",
          tradeoffs: verification.failures.join("; "),
        },
        action: { type: "verify_mandate_chain", mandateId: paymentMandate.id, verdict: "DENY" },
        outcome: { status: "blocked", detail: verification.failures.join("; ") },
      });
    }
    return {
      status: "failed",
      reason: "The authorization could not be verified, so nothing was charged.",
      checks: verification.failures,
    };
  }

  await db
    .update(approvals)
    .set({ status: "approved", decidedBy: input.userId, decidedAt: new Date(), decisionNote: input.note })
    .where(eq(approvals.id, approval.id));

  const orderNumber = `ACP-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 6).toUpperCase()}`;

  const [order] = await db
    .insert(orders)
    .values({
      orderNumber,
      userId: input.userId,
      merchantId: session.merchantId,
      checkoutSessionId: session.id,
      checkoutGroupId: input.checkoutGroupId ?? null,
      state: "pending_payment",
      totals: cart.totals,
      agentSessionId: sessionId,
      placedByAgent: session.agentIdentifier,
    })
    .returning();

  await db.insert(orderItems).values(
    cart.lines.map((line) => ({
      orderId: order.id,
      variantId: line.variantId,
      titleSnapshot: line.title,
      skuSnapshot: line.sku,
      attributesSnapshot: line.attributes,
      quantity: line.quantity,
      unitPriceMinor: line.currentPriceMinor,
    })),
  );

  // Group checkout stops here: the caller creates ONE gateway order covering
  // every merchant, then one payment row per order against it.
  if (input.deferPayment) {
    return {
      status: "order_created",
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountMinor: cart.totals.totalMinor,
      currency: cart.totals.currency,
      paymentMandateId: paymentMandate.id,
      agentSessionId: sessionId,
    };
  }

  const gateway = paymentGateway();
  let gatewayOrder;
  try {
    gatewayOrder = await gateway.createOrder({
      amountMinor: cart.totals.totalMinor,
      currency: cart.totals.currency,
      receipt: order.orderNumber,
      notes: { orderId: order.id, merchant: cart.merchant.slug },
    });
  } catch (cause) {
    await db.update(orders).set({ state: "payment_failed" }).where(eq(orders.id, order.id));
    await releaseStock(cart.lines);
    if (input.sessionId) {
      await record(sessionId, {
        step: "PAY",
        observation: { summary: "Requested a payment order from the gateway." },
        reasoning: { summary: "Gateway rejected the order request." },
        action: { type: "create_gateway_order" },
        outcome: { status: "error", detail: (cause as Error).message },
      });
    }
    return { status: "failed", reason: `Payment could not be started: ${(cause as Error).message}` };
  }

  const [payment] = await db
    .insert(payments)
    .values({
      orderId: order.id,
      gateway: gateway.name,
      gatewayOrderId: gatewayOrder.gatewayOrderId,
      amountMinor: cart.totals.totalMinor,
      currency: cart.totals.currency,
      state: "created",
      paymentMandateId: paymentMandate.id,
      // Stable per checkout session: a retry reuses it and cannot double-charge.
      idempotencyKey: `checkout-${session.id}`,
    })
    .returning();

  await db
    .update(checkoutSessions)
    .set({ state: "ready", updatedAt: new Date() })
    .where(eq(checkoutSessions.id, session.id));

  {
    await record(sessionId, {
      step: "AUTHORIZE",
      observation: {
        summary: `Shopper authorized ${formatMoney(cart.totals.totalMinor)} to ${cart.merchant.name}.`,
      },
      reasoning: {
        summary: `AP2 chain verified: ${verification.checks.filter((c) => c.passed).length}/${verification.checks.length} checks passed.`,
        criteria: undefined,
      },
      action: {
        type: "pay",
        approvalId: approval.id,
        mandateId: paymentMandate.id,
        verdict: "ALLOW",
        requiresApproval: true,
      },
      outcome: { status: "ok", detail: `gateway order ${gatewayOrder.gatewayOrderId}` },
    });
  }

  return {
    status: "authorized",
    orderId: order.id,
    orderNumber: order.orderNumber,
    paymentId: payment.id,
    gatewayOrderId: gatewayOrder.gatewayOrderId,
    gatewayKeyId: gateway.publicKeyId(),
    gateway: gateway.name,
    amountMinor: cart.totals.totalMinor,
    currency: cart.totals.currency,
    paymentMandateId: paymentMandate.id,
  };
}

export type ConfirmResult =
  | { status: "paid"; orderId: string; orderNumber: string }
  | { status: "failed"; reason: string };

/** Final step: verify the gateway result, then commit stock and the order. */
export async function confirmPayment(input: {
  userId: string;
  orderId: string;
  gatewayPaymentId: string;
  signature: string;
  sessionId?: string;
  /**
   * Gateway to verify against. Defaults to the configured one.
   *
   * Passed explicitly by saved-method purchases, which settle through the mock
   * gateway. Doing that by temporarily reassigning process.env would be a race:
   * the server handles requests concurrently, so a widget checkout running at
   * the same moment would read the swapped value.
   */
  gateway?: PaymentGateway;
}): Promise<ConfirmResult> {
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, input.orderId), eq(orders.userId, input.userId)))
    .limit(1);
  if (!order) return { status: "failed", reason: "Order not found." };

  const sessionId =
    input.sessionId ??
    order.agentSessionId ??
    (
      await startSession({
        userId: input.userId,
        kind: "customer",
        title: `Payment for ${order.orderNumber}`,
      })
    ).id;

  // Idempotent: a repeated confirmation is a no-op, not a second charge.
  if (order.state === "paid" || order.state === "fulfilled") {
    return { status: "paid", orderId: order.id, orderNumber: order.orderNumber };
  }

  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.orderId, order.id))
    .limit(1);
  if (!payment?.gatewayOrderId) return { status: "failed", reason: "No payment was started for this order." };

  const gateway = input.gateway ?? paymentGateway();
  const verification = gateway.verifyPaymentSignature({
    gatewayOrderId: payment.gatewayOrderId,
    gatewayPaymentId: input.gatewayPaymentId,
    signature: input.signature,
  });

  // An order may have no live cart (e.g. re-confirmation after cleanup), so
  // stock handling below must tolerate its absence rather than throw.
  const cartId = order.checkoutSessionId ? await sessionCartId(order.checkoutSessionId) : "";
  const cart = cartId ? await loadCart(cartId) : null;

  if (!verification.valid) {
    await db
      .update(payments)
      .set({ state: "failed", failureReason: verification.reason, updatedAt: new Date() })
      .where(eq(payments.id, payment.id));
    await db.update(orders).set({ state: "payment_failed", updatedAt: new Date() }).where(eq(orders.id, order.id));
    if (cart?.lines.length) await releaseStock(cart.lines);

    if (input.sessionId) {
      await record(sessionId, {
        step: "PAY",
        observation: { summary: "Gateway returned a payment result." },
        reasoning: { summary: "Payment signature verification failed — treating as unpaid." },
        action: { type: "verify_payment", verdict: "DENY" },
        outcome: { status: "error", detail: verification.reason },
      });
    }
    return { status: "failed", reason: "Payment could not be verified. You have not been charged." };
  }

  // Re-verify the mandate chain immediately before committing.
  if (payment.paymentMandateId) {
    const chain = await verifyMandateChain(payment.paymentMandateId);
    if (!chain.valid) {
      await db
        .update(payments)
        .set({ state: "failed", failureReason: chain.failures.join("; "), updatedAt: new Date() })
        .where(eq(payments.id, payment.id));
      await db.update(orders).set({ state: "payment_failed" }).where(eq(orders.id, order.id));
      if (cart?.lines.length) await releaseStock(cart.lines);
      return { status: "failed", reason: "Authorization no longer verifies; the payment was not completed." };
    }
    await consumeMandate(payment.paymentMandateId);
  }

  await db
    .update(payments)
    .set({
      state: "captured",
      gatewayPaymentId: input.gatewayPaymentId,
      // Rewritten to the gateway that actually settled, which is not always the
      // one that opened the checkout: a saved-method purchase passes MockGateway
      // explicitly while PAYMENT_GATEWAY is still razorpay. Refunds resolve the
      // gateway from this column, so recording the opener would send a mock
      // payment id to Razorpay.
      gateway: gateway.name,
      updatedAt: new Date(),
    })
    .where(eq(payments.id, payment.id));

  await db.update(orders).set({ state: "paid", updatedAt: new Date() }).where(eq(orders.id, order.id));

  if (cart?.lines.length) {
    await commitStock(cart.lines);
    await markCartConverted(cart.cartId);
  }
  if (order.checkoutSessionId) {
    await db
      .update(checkoutSessions)
      .set({ state: "completed", updatedAt: new Date() })
      .where(eq(checkoutSessions.id, order.checkoutSessionId));
  }

  {
    await record(sessionId, {
      step: "CONFIRM",
      observation: { summary: `Payment captured for order ${order.orderNumber}.` },
      reasoning: { summary: "Signature verified, mandate chain re-verified, stock committed." },
      action: { type: "confirm_payment", verdict: "ALLOW" },
      outcome: { status: "ok", detail: `payment ${input.gatewayPaymentId}` },
    });
  }

  return { status: "paid", orderId: order.id, orderNumber: order.orderNumber };
}

async function sessionCartId(checkoutSessionId: string): Promise<string> {
  const [session] = await db
    .select({ cartId: checkoutSessions.cartId })
    .from(checkoutSessions)
    .where(eq(checkoutSessions.id, checkoutSessionId))
    .limit(1);
  return session?.cartId ?? "";
}
