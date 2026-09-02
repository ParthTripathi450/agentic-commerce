"use server";

import { revalidatePath } from "next/cache";
import { requireMerchant } from "@/lib/session";
import { decideInsightAction, generateInsights, proposeInsightAction } from "./agent";

/** Runs a fresh business review. */
export async function runReviewAction() {
  const { user, merchant } = await requireMerchant();
  const result = await generateInsights({ merchantId: merchant.id, userId: user.id });
  revalidatePath("/merchant/insights");
  return { created: result.created };
}

/** Asks the policy engine whether a recommendation may be executed. */
export async function proposeAction(insightId: string) {
  const { user, merchant } = await requireMerchant();
  const result = await proposeInsightAction({ insightId, userId: user.id, merchantId: merchant.id });
  revalidatePath("/merchant/insights");
  return result;
}

/** Applies or dismisses a recommendation the merchant has decided on. */
export async function decideAction(approvalId: string, decision: "approve" | "reject", note?: string) {
  const { user, merchant } = await requireMerchant();
  const result = await decideInsightAction({
    approvalId,
    userId: user.id,
    merchantId: merchant.id,
    decision,
    note,
  });
  revalidatePath("/merchant/insights");
  revalidatePath("/merchant");
  return result;
}
