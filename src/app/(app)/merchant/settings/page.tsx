import { and, eq } from "drizzle-orm";
import { PageHeader } from "@/components/page-header";
import {
  AgentLimitsForm,
  PoliciesForm,
  StoreProfileForm,
} from "@/components/merchant/settings-forms";
import { db } from "@/db";
import { agentPolicies, merchantPolicies } from "@/db/schema";
import { toMajor } from "@/lib/money";
import { requireMerchant } from "@/lib/session";
import { PLATFORM_DEFAULTS } from "@/server/policy/engine";

export default async function MerchantSettings() {
  const { merchant } = await requireMerchant();

  const [policy] = await db
    .select()
    .from(merchantPolicies)
    .where(eq(merchantPolicies.merchantId, merchant.id))
    .limit(1);

  const [agentPolicy] = await db
    .select()
    .from(agentPolicies)
    .where(and(eq(agentPolicies.scope, "merchant"), eq(agentPolicies.scopeId, merchant.id)))
    .limit(1);

  const limits = { ...PLATFORM_DEFAULTS, ...(agentPolicy?.limits ?? {}) };

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader
        title="Store settings"
        description="Your profile, the policies agents rank you on, and the bounds your own agent must work within."
      />

      <StoreProfileForm
        merchant={{
          name: merchant.name,
          description: merchant.description,
          supportEmail: merchant.supportEmail,
          slug: merchant.slug,
        }}
      />

      <PoliciesForm
        policies={{
          returnsAccepted: policy?.returnsAccepted ?? true,
          returnWindowDays: policy?.returnWindowDays ?? 7,
          returnPolicyText: policy?.returnPolicyText ?? "",
          shippingPolicyText: policy?.shippingPolicyText ?? "",
          standardDeliveryDays: policy?.standardDeliveryDays ?? 4,
          flatShipping: toMajor(policy?.flatShippingMinor ?? 0),
          freeShippingAbove:
            policy?.freeShippingAboveMinor === null || policy?.freeShippingAboveMinor === undefined
              ? ""
              : toMajor(policy.freeShippingAboveMinor),
          warrantyText: policy?.warrantyText ?? "",
          cancellationText: policy?.cancellationText ?? "",
        }}
      />

      <AgentLimitsForm
        limits={{
          maxPriceChangePct: (limits.maxPriceChangeBp ?? 1000) / 100,
          maxDiscountPct: (limits.maxDiscountBp ?? 2000) / 100,
          maxRestockUnits: limits.maxRestockUnits ?? 200,
          maxRestockCost: toMajor(limits.maxRestockCostMinor ?? 0),
          requireApprovalForAll: limits.requireApprovalForAll ?? true,
        }}
      />
    </div>
  );
}
