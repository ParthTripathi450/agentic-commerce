import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { mandates, merchants, users, type Totals } from "@/db/schema";
import {
  createCartMandate,
  createIntentMandate,
  createPaymentMandate,
  verifyMandateChain,
} from "./mandates";
import { hashPayload } from "./keys";

let userId: string;
let merchantId: string;
let merchantSlug: string;

const items = [
  {
    variantId: "test-variant",
    sku: "STR-VELOCITYRU-BLAC-10",
    title: "Velocity Run 3 Road Running Shoes",
    attributes: { color: "black", size: "10" },
    quantity: 1,
    unitPriceMinor: 429900,
  },
];

const totals: Totals = {
  subtotalMinor: 429900,
  discountMinor: 0,
  shippingMinor: 0,
  taxMinor: 77382,
  totalMinor: 507282,
  currency: "INR",
};

async function buildChain(overrides?: {
  totals?: Totals;
  maxAmountMinor?: number | null;
  maxItemPriceMinor?: number | null;
}) {
  const intent = await createIntentMandate({
    userId,
    naturalLanguageIntent: "black running shoes, size 10, under ₹5,000",
    maxAmountMinor: overrides?.maxAmountMinor === undefined ? 600000 : overrides.maxAmountMinor,
    maxItemPriceMinor: overrides?.maxItemPriceMinor ?? null,
    requiredAttributes: { color: "black", size: "10" },
  });
  const cart = await createCartMandate({
    userId,
    merchantId,
    merchantSlug,
    intentMandateId: intent.id,
    items,
    totals: overrides?.totals ?? totals,
  });
  const payment = await createPaymentMandate({
    userId,
    merchantId,
    cartMandateId: cart.id,
    amountMinor: (overrides?.totals ?? totals).totalMinor,
  });
  return { intent, cart, payment };
}

beforeAll(async () => {
  const [user] = await db.select().from(users).where(eq(users.email, "demo@shopper.test")).limit(1);
  const [merchant] = await db
    .select()
    .from(merchants)
    .where(eq(merchants.slug, "stride-athletics"))
    .limit(1);
  userId = user.id;
  merchantId = merchant.id;
  merchantSlug = merchant.slug;
});

describe("AP2 mandate chain", () => {
  it("verifies a well-formed Intent → Cart → Payment chain", async () => {
    const { payment } = await buildChain();
    const result = await verifyMandateChain(payment.id);

    expect(result.failures).toEqual([]);
    expect(result.valid).toBe(true);
    // Signatures from both the shopper and the merchant must be present.
    expect(result.checks.some((c) => c.check === "cart_signature_merchant" && c.passed)).toBe(true);
    expect(result.checks.some((c) => c.check === "cart_signature_user" && c.passed)).toBe(true);
  });

  it("REFUSES a charge when the cart price is edited after signing", async () => {
    const { cart, payment } = await buildChain();

    // Tamper: raise the total directly in the database, as a compromised
    // merchant integration or a bug might.
    const tampered = {
      ...(cart.payload as Record<string, unknown>),
      totals: { ...totals, totalMinor: 999900 },
    };
    await db
      .update(mandates)
      .set({ payload: tampered as never })
      .where(eq(mandates.id, cart.id));

    const result = await verifyMandateChain(payment.id);

    expect(result.valid).toBe(false);
    expect(result.checks.find((c) => c.check === "cart_payload_unmodified")?.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("CART WAS MODIFIED");
    // The merchant's signature no longer covers the stored content either.
    expect(result.checks.find((c) => c.check === "cart_signature_merchant")?.passed).toBe(false);
  });

  it("REFUSES a cart that exceeds the budget the shopper authorised", async () => {
    const expensive: Totals = { ...totals, subtotalMinor: 900000, totalMinor: 950000 };
    const { payment } = await buildChain({ totals: expensive, maxAmountMinor: 600000 });

    const result = await verifyMandateChain(payment.id);

    expect(result.valid).toBe(false);
    expect(result.checks.find((c) => c.check === "cart_within_intent_budget")?.passed).toBe(false);
  });

  it("REFUSES when the payment amount does not match the cart total", async () => {
    const { cart } = await buildChain();
    const payment = await createPaymentMandate({
      userId,
      merchantId,
      cartMandateId: cart.id,
      amountMinor: 100, // charge a different amount than the cart
    });

    const result = await verifyMandateChain(payment.id);
    expect(result.valid).toBe(false);
    expect(result.checks.find((c) => c.check === "amount_matches_cart")?.passed).toBe(false);
  });

  it("REFUSES an expired payment mandate", async () => {
    const { payment } = await buildChain();
    await db
      .update(mandates)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(mandates.id, payment.id));

    const result = await verifyMandateChain(payment.id);
    expect(result.valid).toBe(false);
    expect(result.checks.find((c) => c.check === "payment_not_expired")?.passed).toBe(false);
  });

  it("accepts a cart whose total exceeds the item budget only because of tax", async () => {
    // "under ₹5,000" describes the product. A ₹4,299 item plus 18% GST totals
    // ₹5,072 — within what the shopper meant, and it must not be refused.
    const { payment } = await buildChain({
      maxAmountMinor: null,
      maxItemPriceMinor: 500000,
    });

    const result = await verifyMandateChain(payment.id);
    expect(result.failures).toEqual([]);
    expect(result.checks.find((c) => c.check === "items_within_stated_price")?.passed).toBe(true);
  });

  it("REFUSES an item priced above what the shopper stated", async () => {
    // The same guard still bites when the ITEM itself is over the limit.
    const { payment } = await buildChain({
      maxAmountMinor: null,
      maxItemPriceMinor: 300000, // ₹3,000, below the ₹4,299 item in the cart
    });

    const result = await verifyMandateChain(payment.id);
    expect(result.valid).toBe(false);
    expect(result.checks.find((c) => c.check === "items_within_stated_price")?.passed).toBe(false);
  });

  it("links each mandate to its parent by hash", async () => {
    const { intent, cart, payment } = await buildChain();
    const cartPayload = cart.payload as Record<string, unknown>;
    const paymentPayload = payment.payload as Record<string, unknown>;

    expect(cartPayload.intentMandateHash).toBe(hashPayload(intent.payload));
    expect(paymentPayload.cartMandateHash).toBe(hashPayload(cart.payload));
  });
});
