import { eq } from "drizzle-orm";
import { db } from "@/db";
import { merchantPolicies, merchants, signingKeys } from "@/db/schema";
import { env } from "@/lib/env";
import { getOrCreateSigningKey } from "@/server/protocols/ap2/keys";

/**
 * UCP capability manifest.
 *
 * Published so an agent can discover, without prior arrangement, what this
 * merchant supports: which services exist, which capabilities are implemented,
 * how payment is handled, and the public key its Cart Mandates are signed with
 * — which is what lets an agent verify a quoted price actually came from the
 * merchant rather than from whatever sat in the middle.
 */

export type UcpManifest = {
  ucp_version: string;
  business: {
    id: string;
    name: string;
    slug: string;
    url: string;
    support_email: string | null;
  };
  services: Record<string, { endpoint: string; openapi?: string; description: string }>;
  capabilities: Array<{ name: string; version: string; schema?: string; notes?: string }>;
  payment_handlers: Array<{
    id: string;
    type: string;
    mode: "test" | "live";
    supported_methods: string[];
    /** AP2 mandate types this handler requires before it will charge. */
    requires_mandates: string[];
  }>;
  signing_keys: Array<{ kid: string; alg: string; use: string; jwk: Record<string, unknown> }>;
  policies: {
    currency: string;
    returns_accepted: boolean;
    return_window_days: number;
    standard_delivery_days: number;
  };
  generated_at: string;
};

export async function buildUcpManifest(merchantSlug: string): Promise<UcpManifest | null> {
  const [merchant] = await db
    .select()
    .from(merchants)
    .where(eq(merchants.slug, merchantSlug))
    .limit(1);
  if (!merchant || merchant.status !== "active") return null;

  const [policy] = await db
    .select()
    .from(merchantPolicies)
    .where(eq(merchantPolicies.merchantId, merchant.id))
    .limit(1);

  // Ensure the merchant has a key, so a manifest is never published without one.
  await getOrCreateSigningKey("merchant", merchant.id);
  const keys = await db
    .select()
    .from(signingKeys)
    .where(eq(signingKeys.ownerId, merchant.id));

  const base = env().PLATFORM_URL.replace(/\/$/, "");
  const root = `${base}/api/ucp/${merchant.slug}`;

  return {
    ucp_version: "0.1",
    business: {
      id: merchant.id,
      name: merchant.name,
      slug: merchant.slug,
      url: `${base}/m/${merchant.slug}`,
      support_email: merchant.supportEmail,
    },
    services: {
      "dev.ucp.shopping": {
        endpoint: root,
        description: "Catalog discovery, availability and checkout sessions.",
      },
      "dev.ucp.feed": {
        endpoint: `${base}/api/acp/${merchant.slug}/feed.json`,
        description: "ACP product feed for this merchant's full catalog.",
      },
      "dev.ucp.mcp": {
        endpoint: `${base}/api/mcp`,
        description: "Model Context Protocol endpoint exposing catalog and commerce tools.",
      },
    },
    capabilities: [
      { name: "checkout", version: "0.1", notes: "POST/PUT /checkout-sessions, POST /checkout-sessions/{id}/complete" },
      { name: "catalog.search", version: "0.1", notes: "Hybrid semantic + lexical search with structured filters" },
      { name: "catalog.availability", version: "0.1", notes: "Live per-variant stock" },
      { name: "order.status", version: "0.1" },
      { name: "payment.ap2", version: "0.1", notes: "Intent → Cart → Payment mandate chain" },
    ],
    payment_handlers: [
      {
        id: "razorpay-test",
        type: "razorpay",
        // Stated explicitly so no agent mistakes this for a live endpoint.
        mode: "test",
        supported_methods: ["card", "upi", "netbanking", "wallet"],
        requires_mandates: ["IntentMandate", "CartMandate", "PaymentMandate"],
      },
    ],
    signing_keys: keys.map((key) => ({
      kid: key.kid,
      alg: "ES256",
      use: "sig",
      jwk: key.publicJwk as Record<string, unknown>,
    })),
    policies: {
      currency: policy?.currency ?? "INR",
      returns_accepted: policy?.returnsAccepted ?? false,
      return_window_days: policy?.returnWindowDays ?? 0,
      standard_delivery_days: policy?.standardDeliveryDays ?? 7,
    },
    generated_at: new Date().toISOString(),
  };
}
