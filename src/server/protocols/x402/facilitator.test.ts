import { describe, expect, it } from "vitest";
import { challengeBody, PRICE_ATOMIC, signMockPayment, verifyPayment, X402_VERSION } from "./facilitator";

function encode(payload: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function validPayment(overrides: Record<string, unknown> = {}) {
  const from = "0xabc0000000000000000000000000000000000001";
  const nonce = "nonce-1";
  const value = PRICE_ATOMIC;
  return encode({
    x402Version: X402_VERSION,
    scheme: "exact",
    network: "base-sepolia",
    payload: { from, to: "0x0", value, nonce, signature: signMockPayment(from, value, nonce), ...overrides },
  });
}

describe("x402 payment verification", () => {
  it("challenges an unpaid request with the price and terms", () => {
    const body = challengeBody("https://example.test/resource", "test resource");
    expect(body.x402Version).toBe(X402_VERSION);
    expect(body.accepts[0].maxAmountRequired).toBe(PRICE_ATOMIC);
    expect(body.accepts[0].scheme).toBe("exact");
  });

  it("rejects a request with no payment", () => {
    const result = verifyPayment(null, "res");
    expect(result.valid).toBe(false);
  });

  it("accepts a correctly signed payment", () => {
    const result = verifyPayment(validPayment(), "res");
    expect(result.valid).toBe(true);
    expect(result.valid && result.payer).toMatch(/^0xabc/);
  });

  it("rejects a forged signature", () => {
    const result = verifyPayment(validPayment({ signature: "0".repeat(64) }), "res");
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toMatch(/signature/);
  });

  it("rejects underpayment", () => {
    const from = "0xabc0000000000000000000000000000000000001";
    const nonce = "n";
    const value = "1"; // far below the required amount
    const header = encode({
      x402Version: X402_VERSION,
      scheme: "exact",
      network: "base-sepolia",
      payload: { from, to: "0x0", value, nonce, signature: signMockPayment(from, value, nonce) },
    });
    const result = verifyPayment(header, "res");
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toMatch(/insufficient/);
  });

  it("rejects malformed headers rather than throwing", () => {
    expect(verifyPayment("not-base64-json", "res").valid).toBe(false);
  });
});
