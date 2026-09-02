"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agentPolicies } from "@/db/schema";
import { toMinor } from "@/lib/money";
import { requireUser } from "@/lib/session";
import { resolveLimits } from "./engine";

const schema = z.object({
  maxOrderValue: z.coerce.number().min(1).max(10_000_000),
  maxDailySpend: z.coerce.number().min(1).max(50_000_000),
  maxItemsPerOrder: z.coerce.number().int().min(1).max(50),
  requireApprovalAbove: z.coerce.number().min(0).max(10_000_000),
});

export async function updateLimitsAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const parsed = schema.safeParse({
    maxOrderValue: formData.get("maxOrderValue"),
    maxDailySpend: formData.get("maxDailySpend"),
    maxItemsPerOrder: formData.get("maxItemsPerOrder"),
    requireApprovalAbove: formData.get("requireApprovalAbove"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the values and try again." };
  }

  const limits = {
    maxOrderValueMinor: toMinor(parsed.data.maxOrderValue),
    maxDailySpendMinor: toMinor(parsed.data.maxDailySpend),
    maxItemsPerOrder: parsed.data.maxItemsPerOrder,
    requireApprovalAboveMinor: toMinor(parsed.data.requireApprovalAbove),
  };

  const [existing] = await db
    .select({ id: agentPolicies.id })
    .from(agentPolicies)
    .where(and(eq(agentPolicies.scope, "user"), eq(agentPolicies.scopeId, user.id)))
    .limit(1);

  if (existing) {
    await db
      .update(agentPolicies)
      .set({ limits, updatedAt: new Date() })
      .where(eq(agentPolicies.id, existing.id));
  } else {
    await db.insert(agentPolicies).values({ scope: "user", scopeId: user.id, limits });
  }

  // Show what is actually in force, which may be stricter than what was saved.
  const effective = await resolveLimits({ userId: user.id });
  revalidatePath("/settings/limits");
  return {
    ok: true,
    message:
      effective.maxOrderValueMinor !== limits.maxOrderValueMinor
        ? "Saved. The platform ceiling is stricter than your setting, so the lower limit applies."
        : "Limits saved.",
  };
}
