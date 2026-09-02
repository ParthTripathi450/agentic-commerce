import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Payment gateway abstraction.
 *
 * Razorpay runs in TEST MODE only — this platform must never touch real money.
 * The mock gateway implements the same interface so the entire purchase flow is
 * runnable and testable without credentials, and switching is one env var.
 */

export type GatewayOrder = {
  gatewayOrderId: string;
  amountMinor: number;
  currency: string;
  raw: Record<string, unknown>;
};

export type PaymentVerification = {
  valid: boolean;
  reason: string;
  raw?: Record<string, unknown>;
};

export interface PaymentGateway {
  readonly name: string;
  /** Key id safe to expose to the browser checkout widget. */
  publicKeyId(): string | null;
  createOrder(input: {
    amountMinor: number;
    currency: string;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<GatewayOrder>;
  /** Confirms the client-side payment result genuinely came from the gateway. */
  verifyPaymentSignature(input: {
    gatewayOrderId: string;
    gatewayPaymentId: string;
    signature: string;
  }): PaymentVerification;
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
  fetchPayment(gatewayPaymentId: string): Promise<Record<string, unknown> | null>;
}

/** Constant-time compare so signature checks do not leak via timing. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

class RazorpayGateway implements PaymentGateway {
  readonly name = "razorpay_test";

  private auth(): string {
    const id = env().RAZORPAY_KEY_ID;
    const secret = env().RAZORPAY_KEY_SECRET;
    if (!id || !secret) throw new Error("Razorpay credentials are not configured");
    if (!id.startsWith("rzp_test_")) {
      // Hard stop: a live key would move real money.
      throw new Error("Refusing to run: RAZORPAY_KEY_ID is not a test-mode key");
    }
    return Buffer.from(`${id}:${secret}`).toString("base64");
  }

  publicKeyId() {
    return env().RAZORPAY_KEY_ID ?? null;
  }

  async createOrder(input: {
    amountMinor: number;
    currency: string;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<GatewayOrder> {
    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Basic ${this.auth()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: input.amountMinor,
        currency: input.currency,
        receipt: input.receipt.slice(0, 40),
        notes: input.notes ?? {},
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const raw = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      const error = raw.error as { description?: string } | undefined;
      throw new Error(`Razorpay order creation failed: ${error?.description ?? response.status}`);
    }

    return {
      gatewayOrderId: String(raw.id),
      amountMinor: Number(raw.amount),
      currency: String(raw.currency),
      raw,
    };
  }

  verifyPaymentSignature(input: {
    gatewayOrderId: string;
    gatewayPaymentId: string;
    signature: string;
  }): PaymentVerification {
    const secret = env().RAZORPAY_KEY_SECRET;
    if (!secret) return { valid: false, reason: "gateway secret not configured" };

    const expected = createHmac("sha256", secret)
      .update(`${input.gatewayOrderId}|${input.gatewayPaymentId}`)
      .digest("hex");

    const valid = safeEqual(expected, input.signature);
    return {
      valid,
      reason: valid ? "signature matches" : "signature does not match the order and payment ids",
    };
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const secret = env().RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return safeEqual(expected, signature);
  }

  async fetchPayment(gatewayPaymentId: string) {
    const response = await fetch(`https://api.razorpay.com/v1/payments/${gatewayPaymentId}`, {
      headers: { Authorization: `Basic ${this.auth()}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  }
}

/**
 * Deterministic in-process gateway.
 *
 * Simulates the real contract, including failure: an amount whose minor units
 * end in `01` always declines, so the failure path can be exercised on demand
 * rather than only when a real gateway happens to misbehave.
 */
class MockGateway implements PaymentGateway {
  readonly name = "mock";
  private static readonly SECRET = "mock-gateway-secret";
  private payments = new Map<string, Record<string, unknown>>();

  publicKeyId() {
    return "mock_key";
  }

  async createOrder(input: {
    amountMinor: number;
    currency: string;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<GatewayOrder> {
    const gatewayOrderId = `order_mock_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
    return {
      gatewayOrderId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      raw: { id: gatewayOrderId, amount: input.amountMinor, receipt: input.receipt, mock: true },
    };
  }

  /** Test helper: produces the signature a real gateway would return. */
  static sign(gatewayOrderId: string, gatewayPaymentId: string): string {
    return createHmac("sha256", MockGateway.SECRET)
      .update(`${gatewayOrderId}|${gatewayPaymentId}`)
      .digest("hex");
  }

  static declines(amountMinor: number): boolean {
    return amountMinor % 100 === 1;
  }

  verifyPaymentSignature(input: {
    gatewayOrderId: string;
    gatewayPaymentId: string;
    signature: string;
  }): PaymentVerification {
    const expected = MockGateway.sign(input.gatewayOrderId, input.gatewayPaymentId);
    const valid = safeEqual(expected, input.signature);
    return { valid, reason: valid ? "signature matches" : "signature does not match" };
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const expected = createHmac("sha256", MockGateway.SECRET).update(rawBody).digest("hex");
    return safeEqual(expected, signature);
  }

  async fetchPayment(gatewayPaymentId: string) {
    return this.payments.get(gatewayPaymentId) ?? { id: gatewayPaymentId, status: "captured", mock: true };
  }
}

let cached: PaymentGateway | null = null;

export function paymentGateway(): PaymentGateway {
  if (cached) return cached;
  // process.env wins so tests can force the mock without re-parsing the env cache.
  const selected = process.env.PAYMENT_GATEWAY ?? env().PAYMENT_GATEWAY;
  cached = selected === "razorpay" ? new RazorpayGateway() : new MockGateway();
  return cached;
}

export { MockGateway };
export function resetGatewayCache() {
  cached = null;
}
