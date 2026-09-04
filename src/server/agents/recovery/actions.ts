"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { approvals, recoveryCases } from "@/db/schema";
import { requireMerchant } from "@/lib/session";
import { runRecoverySweep } from "./agent";

/**
 * Merchant-facing controls. Mutations only.
 *
 * Every one re-establishes ownership: a recovery case carries a shopper's
 * contact details and a merchant's money, and "the id was in the URL" is not
 * authorisation.
 */
export async function runSweepAction() {
  const { user, merchant } = await requireMerchant();
  const result = await runRecoverySweep({ merchantId: merchant.id, userId: user.id });
  revalidatePath("/merchant/recovery");
  return {
    ok: true as const,
    message:
      `${result.detected} new case(s) detected. ` +
      `${result.acted} contacted, ${result.escalated} escalated, ${result.stopped} stopped` +
      (result.deferred > 0
        ? `. ${result.deferred} left for the next sweep — this run reached its contact budget.`
        : "."),
  };
}

/**
 * A merchant approving an action the policy engine held back.
 *
 * The approval is recorded and the case released; the ACTION itself happens on
 * the next sweep rather than here, so there is exactly one code path that
 * contacts a shopper and it is the audited one.
 */
export async function decideRecoveryAction(caseId: string, decision: "approve" | "reject") {
  const { user, merchant } = await requireMerchant();

  const [row] = await db.select().from(recoveryCases).where(eq(recoveryCases.id, caseId)).limit(1);
  if (!row || row.merchantId !== merchant.id) return { error: "That case is not yours." };
  if (row.state !== "awaiting_approval") return { error: "That case is not waiting for a decision." };

  if (row.approvalId) {
    await db
      .update(approvals)
      .set({
        status: decision === "approve" ? "approved" : "rejected",
        decidedBy: user.id,
        decidedAt: new Date(),
      })
      .where(eq(approvals.id, row.approvalId));
  }

  await db
    .update(recoveryCases)
    .set(
      decision === "approve"
        ? { state: "diagnosed", nextActionAt: null, updatedAt: new Date() }
        : {
            state: "stopped",
            stopReason: "The merchant declined this recovery action.",
            updatedAt: new Date(),
          },
    )
    .where(eq(recoveryCases.id, caseId));

  revalidatePath("/merchant/recovery");
  return {
    ok: true as const,
    message: decision === "approve" ? "Approved — it will run on the next sweep." : "Declined.",
  };
}

/** Closing a case by hand, with a reason, because a merchant may simply know. */
export async function stopRecoveryAction(caseId: string, reason: string) {
  const { merchant } = await requireMerchant();
  const [row] = await db.select().from(recoveryCases).where(eq(recoveryCases.id, caseId)).limit(1);
  if (!row || row.merchantId !== merchant.id) return { error: "That case is not yours." };

  await db
    .update(recoveryCases)
    .set({
      state: "stopped",
      stopReason: reason.trim() || "Stopped by the merchant.",
      updatedAt: new Date(),
    })
    .where(eq(recoveryCases.id, caseId));

  revalidatePath("/merchant/recovery");
  return { ok: true as const, message: "Case closed." };
}
