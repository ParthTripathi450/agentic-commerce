"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agentPolicies, merchantPolicies, merchants, products } from "@/db/schema";
import { toMinor } from "@/lib/money";
import { requireMerchant } from "@/lib/session";
import { indexCatalog } from "@/server/catalog/indexer";

/**
 * Store profile, policies and agent limits.
 *
 * Policies are not decoration: return window and delivery time are scored
 * criteria in the ranker, and they appear in the ACP feed, the UCP manifest and
 * every product's AI document. Changing them therefore re-indexes the whole
 * catalog — otherwise agents keep ranking on stale terms.
 */

const profileSchema = z.object({
  name: z.string().min(2).max(160),
  description: z.string().max(2000).optional(),
  supportEmail: z.string().email().max(255).optional().or(z.literal("")),
});

export async function updateStoreProfileAction(_prev: unknown, formData: FormData) {
  const { merchant } = await requireMerchant();
  const parsed = profileSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") || undefined,
    supportEmail: formData.get("supportEmail") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the fields and try again." };
  }

  await db
    .update(merchants)
    .set({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      supportEmail: parsed.data.supportEmail || null,
      updatedAt: new Date(),
    })
    .where(eq(merchants.id, merchant.id));

  // The merchant name appears in every product's AI document.
  await reindexMerchant(merchant.id);
  revalidatePath("/merchant/settings");
  return { ok: true, message: "Store profile saved and catalog re-indexed." };
}

const policiesSchema = z.object({
  returnsAccepted: z.coerce.boolean(),
  returnWindowDays: z.coerce.number().int().min(0).max(365),
  returnPolicyText: z.string().max(1000).optional(),
  shippingPolicyText: z.string().max(1000).optional(),
  standardDeliveryDays: z.coerce.number().int().min(1).max(90),
  flatShipping: z.coerce.number().min(0).max(100000),
  freeShippingAbove: z.coerce.number().min(0).max(1000000).optional(),
  warrantyText: z.string().max(1000).optional(),
  cancellationText: z.string().max(1000).optional(),
});

export async function updatePoliciesAction(_prev: unknown, formData: FormData) {
  const { merchant } = await requireMerchant();
  const parsed = policiesSchema.safeParse({
    returnsAccepted: formData.get("returnsAccepted") === "on",
    returnWindowDays: formData.get("returnWindowDays"),
    returnPolicyText: formData.get("returnPolicyText") || undefined,
    shippingPolicyText: formData.get("shippingPolicyText") || undefined,
    standardDeliveryDays: formData.get("standardDeliveryDays"),
    flatShipping: formData.get("flatShipping"),
    freeShippingAbove: formData.get("freeShippingAbove") || undefined,
    warrantyText: formData.get("warrantyText") || undefined,
    cancellationText: formData.get("cancellationText") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the fields and try again." };
  }

  const values = {
    returnsAccepted: parsed.data.returnsAccepted,
    returnWindowDays: parsed.data.returnWindowDays,
    returnPolicyText: parsed.data.returnPolicyText ?? null,
    shippingPolicyText: parsed.data.shippingPolicyText ?? null,
    standardDeliveryDays: parsed.data.standardDeliveryDays,
    flatShippingMinor: toMinor(parsed.data.flatShipping),
    freeShippingAboveMinor:
      parsed.data.freeShippingAbove === undefined ? null : toMinor(parsed.data.freeShippingAbove),
    warrantyText: parsed.data.warrantyText ?? null,
    cancellationText: parsed.data.cancellationText ?? null,
    updatedAt: new Date(),
  };

  await db
    .insert(merchantPolicies)
    .values({ merchantId: merchant.id, ...values })
    .onConflictDoUpdate({ target: merchantPolicies.merchantId, set: values });

  const { indexed } = await reindexMerchant(merchant.id);
  revalidatePath("/merchant/settings");
  revalidatePath("/merchant/protocols");
  return {
    ok: true,
    message: `Policies saved. ${indexed} products re-indexed — agents now rank on the new terms.`,
  };
}

const agentLimitsSchema = z.object({
  maxPriceChangePct: z.coerce.number().min(0).max(90),
  maxDiscountPct: z.coerce.number().min(0).max(90),
  maxRestockUnits: z.coerce.number().int().min(0).max(100000),
  maxRestockCost: z.coerce.number().min(0).max(10000000),
  requireApprovalForAll: z.coerce.boolean(),
});

export async function updateAgentLimitsAction(_prev: unknown, formData: FormData) {
  const { merchant } = await requireMerchant();
  const parsed = agentLimitsSchema.safeParse({
    maxPriceChangePct: formData.get("maxPriceChangePct"),
    maxDiscountPct: formData.get("maxDiscountPct"),
    maxRestockUnits: formData.get("maxRestockUnits"),
    maxRestockCost: formData.get("maxRestockCost"),
    requireApprovalForAll: formData.get("requireApprovalForAll") === "on",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the fields and try again." };
  }

  const limits = {
    maxPriceChangeBp: Math.round(parsed.data.maxPriceChangePct * 100),
    maxDiscountBp: Math.round(parsed.data.maxDiscountPct * 100),
    maxRestockUnits: parsed.data.maxRestockUnits,
    maxRestockCostMinor: toMinor(parsed.data.maxRestockCost),
    allowAutoPublish: false,
    requireApprovalForAll: parsed.data.requireApprovalForAll,
  };

  const [existing] = await db
    .select({ id: agentPolicies.id })
    .from(agentPolicies)
    .where(and(eq(agentPolicies.scope, "merchant"), eq(agentPolicies.scopeId, merchant.id)))
    .limit(1);

  if (existing) {
    await db
      .update(agentPolicies)
      .set({ limits, updatedAt: new Date() })
      .where(eq(agentPolicies.id, existing.id));
  } else {
    await db.insert(agentPolicies).values({ scope: "merchant", scopeId: merchant.id, limits });
  }

  revalidatePath("/merchant/settings");
  return {
    ok: true,
    message: parsed.data.requireApprovalForAll
      ? "Limits saved. Every agent action will still ask for your approval."
      : "Limits saved. Actions within these bounds no longer need individual approval.",
  };
}

async function reindexMerchant(merchantId: string) {
  const rows = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.merchantId, merchantId));
  return indexCatalog({ productIds: rows.map((r) => r.id), force: true });
}
