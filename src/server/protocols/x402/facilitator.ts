import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/**
 * x402 machine-to-machine payments.
 *
 * x402 revives HTTP 402: a server answers an unpaid request with the price and
 * how to pay, the client retries with a signed payment in `X-PAYMENT`.
 *
 * Verification runs against a MOCK facilitator by default so this is
 * demonstrable with no wallet, no testnet funds and no card — consistent with
 * the rest of the platform. The Base Sepolia path is described in
 * `settlementModes` and is a facilitator swap, not a redesign: the request
 * shape, the 402 body and the retry are already protocol-correct.
 */

export const X402_VERSION = 1;
/** USDC has 6 decimals; 1000 atomic units = $0.001. */
export const PRICE_ATOMIC = "1000";
export const NETWORK = "base-sepolia";
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export type PaymentRequirements = {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: Record<string, unknown>;
};

export function paymentRequirements(resource: string, description: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: PRICE_ATOMIC,
    resource,
    description,
    mimeType: "application/json",
    payTo: "0x0000000000000000000000000000000000000ACP",
    maxTimeoutSeconds: 60,
    asset: USDC_BASE_SEPOLIA,
    extra: { name: "USDC", version: "2" },
  };
}

/** The 402 body: price and terms, so a client knows exactly how to retry. */
export function challengeBody(resource: string, description: string) {
  return {
    x402Version: X402_VERSION,
    error: "X-PAYMENT header is required",
    accepts: [paymentRequirements(resource, description)],
    settlementModes: {
      active: mockMode() ? "mock-facilitator" : "base-sepolia",
      note: mockMode()
        ? "This deployment verifies payments locally so the flow needs no wallet or testnet funds. Sign with the documented mock scheme."
        : "Settled on Base Sepolia testnet via an x402 facilitator.",
    },
  };
}

function mockMode(): boolean {
  return (process.env.X402_MODE ?? "mock") === "mock";
}

const MOCK_SECRET = "x402-mock-facilitator";

export type PaymentPayload = {
  x402Version: number;
  scheme: string;
  network: string;
  payload: { from: string; to: string; value: string; nonce: string; signature: string };
};

/** Produces the signature a real wallet would supply. Test/demo clients use this. */
export function signMockPayment(from: string, value: string, nonce: string): string {
  return createHmac("sha256", MOCK_SECRET).update(`${from}|${value}|${nonce}`).digest("hex");
}

export type VerificationResult =
  | { valid: true; payer: string; amount: string }
  | { valid: false; reason: string };

export function verifyPayment(header: string | null, resource: string): VerificationResult {
  if (!header) return { valid: false, reason: "missing X-PAYMENT header" };

  let payment: PaymentPayload;
  try {
    // x402 sends the payload base64-encoded.
    payment = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as PaymentPayload;
  } catch {
    return { valid: false, reason: "X-PAYMENT is not valid base64-encoded JSON" };
  }

  if (payment.x402Version !== X402_VERSION) {
    return { valid: false, reason: `unsupported x402Version ${payment.x402Version}` };
  }
  if (payment.scheme !== "exact") {
    return { valid: false, reason: `unsupported scheme ${payment.scheme}` };
  }
  if (BigInt(payment.payload?.value ?? "0") < BigInt(PRICE_ATOMIC)) {
    return { valid: false, reason: `insufficient payment for ${resource}` };
  }

  if (!mockMode()) {
    // A real facilitator would settle on-chain here.
    return { valid: false, reason: "on-chain settlement is not enabled in this deployment" };
  }

  const expected = signMockPayment(
    payment.payload.from,
    payment.payload.value,
    payment.payload.nonce,
  );
  const provided = payment.payload.signature ?? "";
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: "payment signature did not verify" };
  }

  return { valid: true, payer: payment.payload.from, amount: payment.payload.value };
}

export function resourceUrl(path: string): string {
  return `${env().PLATFORM_URL.replace(/\/$/, "")}${path}`;
}
