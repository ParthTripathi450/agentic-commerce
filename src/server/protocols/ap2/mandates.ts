import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { CompactSign, compactVerify } from "jose";
import { db } from "@/db";
import { mandates } from "@/db/schema";
import type { Totals } from "@/db/schema";
import {
  canonicalize,
  findKeyByKid,
  getOrCreateSigningKey,
  hashPayload,
  loadPrivateKey,
  loadPublicKey,
  MANDATE_ALG,
  type KeyOwnerType,
} from "./keys";

/**
 * AP2 mandate chain: Intent → Cart → Payment.
 *
 * Each mandate is signed over a canonical JSON serialisation, and each child
 * embeds the SHA-256 hash of its parent. That hash link is what gives the chain
 * its teeth: edit a cart's price after the shopper approved it and the Payment
 * Mandate's recorded parent hash no longer matches, so verification fails and
 * the charge is refused rather than silently going through at the new price.
 */

export const MANDATE_VERSION = "0.1";

export type IntentPayload = {
  type: "IntentMandate";
  version: string;
  id: string;
  userId: string;
  naturalLanguageIntent: string;
  constraints: {
    /**
     * Ceiling on the TOTAL charged, tax and shipping included.
     */
    maxAmountMinor: number | null;
    /**
     * Ceiling on any single item's unit price, as the shopper expressed it.
     *
     * Separate from maxAmountMinor because "under ₹5,000" is a statement about
     * the product, not the invoice: a ₹4,299 item plus 18% GST is ₹5,072, and
     * comparing that total against the item budget rejects a cart the shopper
     * would plainly consider within their limit.
     */
    maxItemPriceMinor: number | null;
    currency: string;
    category: string | null;
    requiredAttributes: Record<string, string>;
    allowedMerchantIds: string[] | null;
  };
  createdAt: string;
  expiresAt: string;
  nonce: string;
};

export type CartItemPayload = {
  variantId: string;
  sku: string;
  title: string;
  attributes: Record<string, string>;
  quantity: number;
  unitPriceMinor: number;
};

export type CartPayload = {
  type: "CartMandate";
  version: string;
  id: string;
  intentMandateId: string;
  intentMandateHash: string;
  userId: string;
  merchantId: string;
  merchantSlug: string;
  items: CartItemPayload[];
  totals: Totals;
  createdAt: string;
  expiresAt: string;
  nonce: string;
};

export type PaymentPayload = {
  type: "PaymentMandate";
  version: string;
  id: string;
  cartMandateId: string;
  cartMandateHash: string;
  userId: string;
  merchantId: string;
  amountMinor: number;
  currency: string;
  paymentMethod: { kind: string; label: string };
  createdAt: string;
  expiresAt: string;
  nonce: string;
};

export type MandatePayload = IntentPayload | CartPayload | PaymentPayload;

/** Detached-style compact JWS over the canonical payload bytes. */
async function sign(payload: MandatePayload, ownerType: KeyOwnerType, ownerId: string) {
  const key = await getOrCreateSigningKey(ownerType, ownerId);
  const privateKey = await loadPrivateKey(key.privateJwk);
  const jws = await new CompactSign(new TextEncoder().encode(canonicalize(payload)))
    .setProtectedHeader({ alg: MANDATE_ALG, kid: key.kid })
    .sign(privateKey);
  return { signer: ownerType, kid: key.kid, jws };
}

async function verifySignature(payload: unknown, entry: { kid: string; jws: string }) {
  const key = await findKeyByKid(entry.kid);
  if (!key) return { valid: false, reason: `unknown signing key ${entry.kid}` };
  try {
    const { payload: signed } = await compactVerify(entry.jws, await loadPublicKey(key.publicJwk));
    const signedText = new TextDecoder().decode(signed);
    if (signedText !== canonicalize(payload)) {
      return { valid: false, reason: `signature covers different content than the stored payload` };
    }
    return { valid: true, reason: "ok" };
  } catch (cause) {
    return { valid: false, reason: `signature invalid: ${(cause as Error).message}` };
  }
}

const minutes = (n: number) => new Date(Date.now() + n * 60_000);

// ---------------------------------------------------------------- creation

export async function createIntentMandate(input: {
  userId: string;
  sessionId?: string;
  naturalLanguageIntent: string;
  maxAmountMinor: number | null;
  maxItemPriceMinor?: number | null;
  currency?: string;
  category?: string | null;
  requiredAttributes?: Record<string, string>;
  allowedMerchantIds?: string[] | null;
  ttlMinutes?: number;
}) {
  const id = randomUUID();
  const expiresAt = minutes(input.ttlMinutes ?? 60);
  const payload: IntentPayload = {
    type: "IntentMandate",
    version: MANDATE_VERSION,
    id,
    userId: input.userId,
    naturalLanguageIntent: input.naturalLanguageIntent,
    constraints: {
      maxAmountMinor: input.maxAmountMinor,
      maxItemPriceMinor: input.maxItemPriceMinor ?? null,
      currency: input.currency ?? "INR",
      category: input.category ?? null,
      requiredAttributes: input.requiredAttributes ?? {},
      allowedMerchantIds: input.allowedMerchantIds ?? null,
    },
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
    nonce: randomUUID(),
  };

  const signature = await sign(payload, "user", input.userId);
  const [row] = await db
    .insert(mandates)
    .values({
      id,
      type: "intent",
      userId: input.userId,
      sessionId: input.sessionId ?? null,
      payload,
      payloadHash: hashPayload(payload),
      signatures: [signature],
      expiresAt,
    })
    .returning();
  return row;
}

/**
 * Cart Mandate, signed by BOTH parties.
 *
 * The merchant signs to attest the quoted prices are genuinely theirs; the
 * shopper signs to approve that exact cart. Neither side can later claim a
 * different price was agreed.
 */
export async function createCartMandate(input: {
  userId: string;
  merchantId: string;
  merchantSlug: string;
  sessionId?: string;
  intentMandateId: string;
  items: CartItemPayload[];
  totals: Totals;
  ttlMinutes?: number;
}) {
  const [intent] = await db
    .select()
    .from(mandates)
    .where(eq(mandates.id, input.intentMandateId))
    .limit(1);
  if (!intent) throw new Error("intent mandate not found");

  const id = randomUUID();
  const expiresAt = minutes(input.ttlMinutes ?? 30);
  const payload: CartPayload = {
    type: "CartMandate",
    version: MANDATE_VERSION,
    id,
    intentMandateId: intent.id,
    intentMandateHash: intent.payloadHash,
    userId: input.userId,
    merchantId: input.merchantId,
    merchantSlug: input.merchantSlug,
    items: input.items,
    totals: input.totals,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
    nonce: randomUUID(),
  };

  const signatures = [
    await sign(payload, "merchant", input.merchantId),
    await sign(payload, "user", input.userId),
  ];

  const [row] = await db
    .insert(mandates)
    .values({
      id,
      type: "cart",
      parentId: intent.id,
      userId: input.userId,
      merchantId: input.merchantId,
      sessionId: input.sessionId ?? null,
      payload,
      payloadHash: hashPayload(payload),
      signatures,
      expiresAt,
    })
    .returning();
  return row;
}

export async function createPaymentMandate(input: {
  userId: string;
  merchantId: string;
  sessionId?: string;
  cartMandateId: string;
  amountMinor: number;
  currency?: string;
  paymentMethod?: { kind: string; label: string };
  ttlMinutes?: number;
}) {
  const [cart] = await db
    .select()
    .from(mandates)
    .where(eq(mandates.id, input.cartMandateId))
    .limit(1);
  if (!cart) throw new Error("cart mandate not found");

  const id = randomUUID();
  const expiresAt = minutes(input.ttlMinutes ?? 15);
  const payload: PaymentPayload = {
    type: "PaymentMandate",
    version: MANDATE_VERSION,
    id,
    cartMandateId: cart.id,
    cartMandateHash: cart.payloadHash,
    userId: input.userId,
    merchantId: input.merchantId,
    amountMinor: input.amountMinor,
    currency: input.currency ?? "INR",
    paymentMethod: input.paymentMethod ?? { kind: "razorpay_test", label: "Razorpay (test mode)" },
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
    nonce: randomUUID(),
  };

  const signature = await sign(payload, "user", input.userId);
  const [row] = await db
    .insert(mandates)
    .values({
      id,
      type: "payment",
      parentId: cart.id,
      userId: input.userId,
      merchantId: input.merchantId,
      sessionId: input.sessionId ?? null,
      payload,
      payloadHash: hashPayload(payload),
      signatures: [signature],
      expiresAt,
    })
    .returning();
  return row;
}

// ------------------------------------------------------------ verification

export type ChainCheck = { check: string; passed: boolean; detail: string };

export type ChainVerification = {
  valid: boolean;
  checks: ChainCheck[];
  failures: string[];
  intentId?: string;
  cartId?: string;
  paymentId?: string;
};

/**
 * Verifies payment → cart → intent before any money moves.
 *
 * Checks signatures, expiry, status, the parent-hash links, and that the cart
 * actually satisfies the constraints the shopper originally authorised.
 */
export async function verifyMandateChain(paymentMandateId: string): Promise<ChainVerification> {
  const checks: ChainCheck[] = [];
  const add = (check: string, passed: boolean, detail: string) =>
    checks.push({ check, passed, detail });

  const [payment] = await db.select().from(mandates).where(eq(mandates.id, paymentMandateId)).limit(1);
  if (!payment) {
    return { valid: false, checks: [{ check: "payment_mandate_exists", passed: false, detail: "not found" }], failures: ["payment mandate not found"] };
  }

  const paymentPayload = payment.payload as unknown as PaymentPayload;
  add("payment_mandate_exists", true, `payment mandate ${payment.id}`);
  add("payment_status_active", payment.status === "active", `status is ${payment.status}`);
  add("payment_not_expired", payment.expiresAt > new Date(), `expires ${payment.expiresAt.toISOString()}`);

  for (const signature of payment.signatures) {
    const result = await verifySignature(payment.payload, signature);
    add(`payment_signature_${signature.signer}`, result.valid, result.reason);
  }
  add(
    "payment_payload_unmodified",
    hashPayload(payment.payload) === payment.payloadHash,
    "stored hash matches recomputed payload hash",
  );

  const [cart] = await db.select().from(mandates).where(eq(mandates.id, paymentPayload.cartMandateId)).limit(1);
  if (!cart) {
    add("cart_mandate_exists", false, "referenced cart mandate not found");
    return finish(checks, payment.id);
  }
  const cartPayload = cart.payload as unknown as CartPayload;
  add("cart_mandate_exists", true, `cart mandate ${cart.id}`);
  add("cart_not_expired", cart.expiresAt > new Date(), `expires ${cart.expiresAt.toISOString()}`);

  // The tamper check: the cart must be byte-identical to what was authorised.
  const cartHashNow = hashPayload(cart.payload);
  add(
    "cart_payload_unmodified",
    cartHashNow === cart.payloadHash,
    cartHashNow === cart.payloadHash
      ? "cart content matches its stored hash"
      : "CART WAS MODIFIED after signing",
  );
  add(
    "payment_links_to_cart",
    paymentPayload.cartMandateHash === cart.payloadHash,
    paymentPayload.cartMandateHash === cart.payloadHash
      ? "payment mandate references this exact cart"
      : "payment mandate references a DIFFERENT cart state than the one stored",
  );

  for (const signature of cart.signatures) {
    const result = await verifySignature(cart.payload, signature);
    add(`cart_signature_${signature.signer}`, result.valid, result.reason);
  }

  add(
    "amount_matches_cart",
    paymentPayload.amountMinor === cartPayload.totals.totalMinor,
    `payment ${paymentPayload.amountMinor} vs cart total ${cartPayload.totals.totalMinor}`,
  );

  const [intent] = await db.select().from(mandates).where(eq(mandates.id, cartPayload.intentMandateId)).limit(1);
  if (!intent) {
    add("intent_mandate_exists", false, "referenced intent mandate not found");
    return finish(checks, payment.id, cart.id);
  }
  const intentPayload = intent.payload as unknown as IntentPayload;
  add("intent_mandate_exists", true, `intent mandate ${intent.id}`);
  add(
    "cart_links_to_intent",
    cartPayload.intentMandateHash === intent.payloadHash,
    cartPayload.intentMandateHash === intent.payloadHash
      ? "cart references this exact intent"
      : "cart references a different intent state",
  );
  for (const signature of intent.signatures) {
    const result = await verifySignature(intent.payload, signature);
    add(`intent_signature_${signature.signer}`, result.valid, result.reason);
  }

  // Does the cart honour what the shopper actually authorised?
  const maxAmount = intentPayload.constraints.maxAmountMinor;
  if (typeof maxAmount === "number") {
    add(
      "cart_within_intent_budget",
      cartPayload.totals.totalMinor <= maxAmount,
      `cart total ${cartPayload.totals.totalMinor} vs authorised max ${maxAmount}`,
    );
  }

  const maxItemPrice = intentPayload.constraints.maxItemPriceMinor;
  if (typeof maxItemPrice === "number") {
    const dearest = Math.max(...cartPayload.items.map((i) => i.unitPriceMinor), 0);
    add(
      "items_within_stated_price",
      dearest <= maxItemPrice,
      `dearest item ${dearest} vs stated limit ${maxItemPrice}`,
    );
  }
  if (intentPayload.constraints.allowedMerchantIds?.length) {
    add(
      "merchant_authorised_by_intent",
      intentPayload.constraints.allowedMerchantIds.includes(cartPayload.merchantId),
      `merchant ${cartPayload.merchantSlug}`,
    );
  }
  const required = intentPayload.constraints.requiredAttributes ?? {};
  if (Object.keys(required).length > 0) {
    const satisfied = cartPayload.items.every((item) =>
      Object.entries(required).every(
        ([key, value]) => String(item.attributes[key] ?? "").toLowerCase() === value.toLowerCase(),
      ),
    );
    add("items_match_intent_attributes", satisfied, JSON.stringify(required));
  }
  add(
    "same_user_throughout",
    intentPayload.userId === cartPayload.userId && cartPayload.userId === paymentPayload.userId,
    "all three mandates belong to the same shopper",
  );

  return finish(checks, payment.id, cart.id, intent.id);
}

function finish(
  checks: ChainCheck[],
  paymentId?: string,
  cartId?: string,
  intentId?: string,
): ChainVerification {
  const failures = checks.filter((c) => !c.passed).map((c) => `${c.check}: ${c.detail}`);
  return { valid: failures.length === 0, checks, failures, paymentId, cartId, intentId };
}

/** Marks a mandate consumed so it cannot authorise a second charge. */
export async function consumeMandate(mandateId: string) {
  await db
    .update(mandates)
    .set({ status: "consumed", updatedAt: new Date() })
    .where(eq(mandates.id, mandateId));
}
