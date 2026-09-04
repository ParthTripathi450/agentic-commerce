import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentPolicies, orders, type PolicyLimits } from "@/db/schema";
import type { PolicyVerdict } from "@/lib/agent-types";
import { bpToPercent, formatMoney } from "@/lib/money";

/**
 * The policy engine.
 *
 * Every money-moving or catalog-mutating action passes through here before it
 * happens. Both DENY and REQUIRE_APPROVAL carry a human-readable reason and the
 * exact bound that produced them, so a refusal is as auditable as a completion.
 */

export type PolicyAction =
  // customer side
  | { type: "create_cart"; merchantId: string; totalMinor: number; itemCount: number }
  | { type: "checkout"; merchantId: string; totalMinor: number; itemCount: number }
  | { type: "pay"; merchantId: string; amountMinor: number }
  // merchant-agent side
  | { type: "merchant_price_change"; fromMinor: number; toMinor: number }
  | { type: "merchant_discount"; bp: number }
  | { type: "merchant_restock"; units: number; costMinor: number }
  | { type: "merchant_availability"; enable: boolean }
  | { type: "merchant_publish" }
  // revenue-recovery side. Every recovery action is money or the shopper's
  // attention, so all of them are gated here rather than inside the agent.
  | { type: "recovery_message"; messagesSoFar: number }
  | { type: "recovery_retry"; retriesSoFar: number }
  | { type: "recovery_incentive"; bp: number; amountMinor: number };

export type PolicyContext = {
  userId?: string;
  merchantId?: string;
};

export type Violation = {
  limit: string;
  limitValue: number | string;
  actual: number | string;
  message: string;
};

export type PolicyDecision = {
  verdict: PolicyVerdict;
  reason: string;
  boundsChecked: string[];
  violations: Violation[];
  limits: PolicyLimits;
};

/**
 * Platform defaults. Deliberately conservative: an unconfigured deployment is
 * safe rather than permissive, and payment always needs explicit consent.
 */
export const PLATFORM_DEFAULTS: PolicyLimits = {
  // Recovery: bounded low on purpose. An agent that contacts a shopper twice
  // and stops is recoverable from; one that contacts them ten times has
  // already cost the merchant the customer.
  maxRecoveryRetries: 2,
  maxRecoveryMessages: 2,
  maxRecoveryDiscountBp: 1000,
  maxRecoveryDiscountMinor: 50_000,
  allowAutoRecovery: true,
  // Bounded, but sized for a catalog that legitimately sells ₹12,000 items.
  // The meaningful guard is requireApprovalAboveMinor: 0 below — every payment
  // needs explicit consent — not an arbitrarily low ceiling.
  maxOrderValueMinor: 50_000_00,
  maxDailySpendMinor: 100_000_00,
  maxItemsPerOrder: 10,
  requireApprovalAboveMinor: 0,
  maxPriceChangeBp: 1000,
  maxDiscountBp: 2000,
  maxRestockUnits: 200,
  maxRestockCostMinor: 100_000_00,
  allowAutoPublish: false,
  requireApprovalForAll: true,
};

/**
 * Resolves effective limits for a scope.
 *
 * The platform limit is a CEILING, not a default: a per-user or per-merchant
 * limit can only ever be stricter. Otherwise raising your own limit would let
 * you escape the platform bound entirely.
 */
export async function resolveLimits(context: PolicyContext): Promise<PolicyLimits> {
  const scopes = await db
    .select()
    .from(agentPolicies)
    .where(
      sql`(${agentPolicies.scope} = 'platform')
          OR (${agentPolicies.scope} = 'user' AND ${agentPolicies.scopeId} = ${context.userId ?? null})
          OR (${agentPolicies.scope} = 'merchant' AND ${agentPolicies.scopeId} = ${context.merchantId ?? null})`,
    );

  const platform = scopes.find((s) => s.scope === "platform")?.limits ?? {};
  const specific = scopes.filter((s) => s.scope !== "platform").map((s) => s.limits);

  const ceiling: PolicyLimits = { ...PLATFORM_DEFAULTS, ...platform };
  const effective: PolicyLimits = { ...ceiling };

  const numericMaxima = [
    "maxOrderValueMinor",
    "maxDailySpendMinor",
    "maxItemsPerOrder",
    "maxPriceChangeBp",
    "maxDiscountBp",
    "maxRestockUnits",
    "maxRestockCostMinor",
  ] as const;

  for (const limits of specific) {
    for (const key of numericMaxima) {
      const candidate = limits[key];
      if (typeof candidate !== "number") continue;
      const current = effective[key];
      // Stricter always wins.
      effective[key] = typeof current === "number" ? Math.min(current, candidate) : candidate;
    }
    if (typeof limits.requireApprovalAboveMinor === "number") {
      const current = effective.requireApprovalAboveMinor;
      effective.requireApprovalAboveMinor =
        typeof current === "number"
          ? Math.min(current, limits.requireApprovalAboveMinor)
          : limits.requireApprovalAboveMinor;
    }
    // Restrictive booleans can only be turned ON by a narrower scope.
    if (limits.requireApprovalForAll) effective.requireApprovalForAll = true;
    if (limits.allowAutoPublish === false) effective.allowAutoPublish = false;
    if (limits.allowedMerchantIds) effective.allowedMerchantIds = limits.allowedMerchantIds;
    if (limits.blockedMerchantIds) {
      effective.blockedMerchantIds = [
        ...(effective.blockedMerchantIds ?? []),
        ...limits.blockedMerchantIds,
      ];
    }
    if (limits.allowedCategories) effective.allowedCategories = limits.allowedCategories;
  }

  return effective;
}

/** Total already committed today, so a series of small orders cannot exceed the cap. */
export async function spentTodayMinor(userId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [row] = await db
    .select({
      total: sql<number>`COALESCE(SUM((${orders.totals}->>'totalMinor')::bigint), 0)::bigint`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.userId, userId),
        gte(orders.createdAt, startOfDay),
        inArray(orders.state, ["paid", "fulfilled", "pending_payment"]),
      ),
    );

  return Number(row?.total ?? 0);
}

export async function evaluatePolicy(
  action: PolicyAction,
  context: PolicyContext,
): Promise<PolicyDecision> {
  const limits = await resolveLimits(context);
  const boundsChecked: string[] = [];
  const violations: Violation[] = [];

  const denyIfOver = (
    name: keyof PolicyLimits,
    actual: number,
    format: (n: number) => string = String,
  ) => {
    const limit = limits[name];
    if (typeof limit !== "number") return;
    boundsChecked.push(name);
    if (actual > limit) {
      violations.push({
        limit: name,
        limitValue: limit,
        actual,
        message: `${format(actual)} exceeds the ${format(limit)} limit`,
      });
    }
  };

  switch (action.type) {
    case "create_cart":
    case "checkout": {
      denyIfOver("maxOrderValueMinor", action.totalMinor, (n) => formatMoney(n));
      denyIfOver("maxItemsPerOrder", action.itemCount);

      if (limits.blockedMerchantIds?.includes(action.merchantId)) {
        boundsChecked.push("blockedMerchantIds");
        violations.push({
          limit: "blockedMerchantIds",
          limitValue: "blocked",
          actual: action.merchantId,
          message: "This merchant is on your blocked list",
        });
      }
      if (limits.allowedMerchantIds?.length && !limits.allowedMerchantIds.includes(action.merchantId)) {
        boundsChecked.push("allowedMerchantIds");
        violations.push({
          limit: "allowedMerchantIds",
          limitValue: "allow-list",
          actual: action.merchantId,
          message: "This merchant is not on your allowed list",
        });
      }

      if (context.userId) {
        const spent = await spentTodayMinor(context.userId);
        boundsChecked.push("maxDailySpendMinor");
        if (
          typeof limits.maxDailySpendMinor === "number" &&
          spent + action.totalMinor > limits.maxDailySpendMinor
        ) {
          violations.push({
            limit: "maxDailySpendMinor",
            limitValue: limits.maxDailySpendMinor,
            actual: spent + action.totalMinor,
            message:
              `${formatMoney(spent + action.totalMinor)} would exceed your ` +
              `${formatMoney(limits.maxDailySpendMinor)} daily limit ` +
              `(${formatMoney(spent)} already committed today)`,
          });
        }
      }
      break;
    }

    case "pay": {
      denyIfOver("maxOrderValueMinor", action.amountMinor, (n) => formatMoney(n));
      break;
    }

    case "merchant_price_change": {
      const deltaBp = Math.round(
        (Math.abs(action.toMinor - action.fromMinor) / Math.max(action.fromMinor, 1)) * 10_000,
      );
      denyIfOver("maxPriceChangeBp", deltaBp, (n) => `${bpToPercent(n).toFixed(1)}%`);
      break;
    }

    case "merchant_discount": {
      denyIfOver("maxDiscountBp", action.bp, (n) => `${bpToPercent(n).toFixed(1)}%`);
      break;
    }

    case "merchant_restock": {
      denyIfOver("maxRestockUnits", action.units);
      denyIfOver("maxRestockCostMinor", action.costMinor, (n) => formatMoney(n));
      break;
    }

    case "merchant_publish": {
      boundsChecked.push("allowAutoPublish");
      if (!limits.allowAutoPublish) {
        return {
          verdict: "REQUIRE_APPROVAL",
          reason: "Publishing catalog changes requires merchant approval.",
          boundsChecked,
          violations: [],
          limits,
        };
      }
      break;
    }

    case "merchant_availability":
      boundsChecked.push("requireApprovalForAll");
      break;

    /*
     * Recovery actions are counted BEFORE they happen.
     *
     * `messagesSoFar` is what has already been sent, so the check is whether
     * one MORE is allowed. Passing the count in rather than reading it here
     * keeps the engine pure and lets the caller enforce the same rule against
     * a case row that is the single source of truth for it.
     */
    case "recovery_message": {
      denyIfOver("maxRecoveryMessages", action.messagesSoFar + 1);
      break;
    }

    case "recovery_retry": {
      denyIfOver("maxRecoveryRetries", action.retriesSoFar + 1);
      break;
    }

    case "recovery_incentive": {
      // Both bounds, because a percentage of a large basket is a large sum and
      // a merchant who capped the percentage did not agree to the cash.
      denyIfOver("maxRecoveryDiscountBp", action.bp, (n) => `${bpToPercent(n).toFixed(1)}%`);
      denyIfOver("maxRecoveryDiscountMinor", action.amountMinor, (n) => formatMoney(n));
      break;
    }
  }

  /*
   * A merchant who has not switched automatic recovery on gets an approval for
   * every recovery action, whatever the amounts.
   */
  if (action.type.startsWith("recovery_") && limits.allowAutoRecovery === false) {
    boundsChecked.push("allowAutoRecovery");
    if (violations.length === 0) {
      return {
        verdict: "REQUIRE_APPROVAL",
        reason: "This merchant reviews every recovery action before it happens.",
        boundsChecked,
        violations,
        limits,
      };
    }
  }

  if (violations.length > 0) {
    return {
      verdict: "DENY",
      reason: violations.map((v) => v.message).join("; "),
      boundsChecked,
      violations,
      limits,
    };
  }

  // Payment is never automatic: explicit human consent is the default posture.
  const amount =
    action.type === "pay"
      ? action.amountMinor
      : action.type === "checkout" || action.type === "create_cart"
        ? action.totalMinor
        : 0;

  const needsApproval =
    limits.requireApprovalForAll === true ||
    (typeof limits.requireApprovalAboveMinor === "number" &&
      amount > limits.requireApprovalAboveMinor);

  if (action.type === "pay" || action.type === "checkout") {
    if (needsApproval) {
      return {
        verdict: "REQUIRE_APPROVAL",
        reason:
          typeof limits.requireApprovalAboveMinor === "number" && limits.requireApprovalAboveMinor === 0
            ? "All payments require your explicit authorization."
            : `${formatMoney(amount)} is above your ${formatMoney(limits.requireApprovalAboveMinor ?? 0)} auto-approve threshold.`,
        boundsChecked,
        violations: [],
        limits,
      };
    }
  }

  if (action.type.startsWith("merchant_") && limits.requireApprovalForAll) {
    return {
      verdict: "REQUIRE_APPROVAL",
      reason: "This merchant requires approval before the agent executes any action.",
      boundsChecked,
      violations: [],
      limits,
    };
  }

  return {
    verdict: "ALLOW",
    reason: "Within all configured limits.",
    boundsChecked,
    violations: [],
    limits,
  };
}
