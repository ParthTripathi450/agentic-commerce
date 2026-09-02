"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { paymentMethods } from "@/db/schema";
import { requireUser } from "@/lib/session";
import { authorizeCheckout, confirmPayment } from "@/server/commerce/checkout";
import { MockGateway } from "@/server/commerce/gateway";

/**
 * Saved payment methods for agent-completed purchases.
 *
 * The application never accepts a card number. Enabling a method generates
 * fabricated display metadata server-side, and the charge itself runs through
 * the mock gateway — no real money, no real credential, nothing to leak.
 */

const TEST_BRANDS = [
  { brand: "visa", last4: "4242" },
  { brand: "mastercard", last4: "5454" },
  { brand: "rupay", last4: "6521" },
] as const;

export async function enableTestPaymentMethodAction() {
  const user = await requireUser();

  const [existing] = await db
    .select({ id: paymentMethods.id })
    .from(paymentMethods)
    .where(eq(paymentMethods.userId, user.id))
    .limit(1);
  if (existing) return { ok: true, message: "A test payment method is already set up." };

  // Deterministic-ish but arbitrary: this is display metadata, not a credential.
  const choice = TEST_BRANDS[Math.floor(Math.random() * TEST_BRANDS.length)];
  const now = new Date();

  await db.insert(paymentMethods).values({
    userId: user.id,
    brand: choice.brand,
    last4: choice.last4,
    holderName: user.name ?? "Test Shopper",
    expiryMonth: 12,
    expiryYear: now.getFullYear() + 3,
    gateway: "mock",
    isDefault: true,
  });

  revalidatePath("/settings/limits");
  revalidatePath("/shop");
  return { ok: true, message: "Test payment method enabled. The agent can now complete purchases you approve." };
}

export async function removePaymentMethodAction(id: string) {
  const user = await requireUser();
  await db
    .delete(paymentMethods)
    .where(and(eq(paymentMethods.id, id), eq(paymentMethods.userId, user.id)));
  revalidatePath("/settings/limits");
  revalidatePath("/shop");
  return { ok: true, message: "Payment method removed. Purchases will use the checkout window again." };
}

export type SavedPaymentResult =
  | { status: "paid"; orderId: string; orderNumber: string }
  | { status: "needs_widget"; reason: string }
  | { status: "failed"; reason: string; checks?: string[] };

/**
 * Completes an approved purchase using the saved method.
 *
 * Runs only AFTER a human approved the specific approval record — this is the
 * step the shopper's "Allow" authorises, not a way to bypass it. The mandate
 * chain is verified inside authorizeCheckout and again inside confirmPayment.
 */
export async function payWithSavedMethod(input: {
  approvalId: string;
  sessionId?: string;
}): Promise<SavedPaymentResult> {
  const user = await requireUser();

  const [method] = await db
    .select()
    .from(paymentMethods)
    .where(and(eq(paymentMethods.userId, user.id), eq(paymentMethods.isDefault, true)))
    .limit(1);

  if (!method) {
    return { status: "needs_widget", reason: "No saved payment method." };
  }

  const authorized = await authorizeCheckout({
    userId: user.id,
    approvalId: input.approvalId,
    decision: "approve",
    sessionId: input.sessionId,
  });

  if (authorized.status !== "authorized") {
    return {
      status: "failed",
      reason: authorized.status === "rejected" ? authorized.reason : authorized.reason,
      checks: "checks" in authorized ? authorized.checks : undefined,
    };
  }

  // A real gateway will not charge a stored card without tokenisation, which
  // this project does not implement. Fall back to the hosted widget and say so.
  if (authorized.gateway !== "mock") {
    return {
      status: "needs_widget",
      reason:
        "Razorpay test mode cannot charge a saved card server-side, so the checkout window is used instead.",
    };
  }

  const gatewayPaymentId = `pay_saved_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
  const confirmed = await confirmPayment({
    userId: user.id,
    orderId: authorized.orderId,
    gatewayPaymentId,
    signature: MockGateway.sign(authorized.gatewayOrderId, gatewayPaymentId),
    sessionId: input.sessionId,
  });

  if (confirmed.status !== "paid") {
    return { status: "failed", reason: confirmed.reason };
  }

  revalidatePath("/orders");
  return { status: "paid", orderId: confirmed.orderId, orderNumber: confirmed.orderNumber };
}
