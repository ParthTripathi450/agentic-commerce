import { PageHeader } from "@/components/page-header";
import { RecoveryBoard, type BoardCase } from "@/components/merchant/recovery-board";
import { requireMerchant } from "@/lib/session";
import { recoveryMetrics } from "@/server/agents/recovery/agent";
import { listCases, timelinesFor } from "@/server/agents/recovery/queries";

/**
 * Revenue recovery, for the merchant.
 *
 * The page a merchant judges the agent by, so it leads with the two numbers
 * that decide whether it is worth running — what is at risk, and what actually
 * came back — and shows the reasoning behind every case rather than only its
 * verdict.
 */
export default async function RecoveryPage() {
  const { merchant } = await requireMerchant();
  const [metrics, cases, timelines] = await Promise.all([
    recoveryMetrics(merchant.id),
    listCases(merchant.id),
    timelinesFor(merchant.id),
  ]);

  const board: BoardCase[] = cases.map((c) => {
    const diagnosis = (c.evidence as { diagnosis?: { summary?: string; basis?: string[] } })
      ?.diagnosis;
    return {
      id: c.id,
      scenario: c.scenario,
      state: c.state,
      diagnosis: c.diagnosis,
      amountAtRiskMinor: c.amountAtRiskMinor,
      recoveredMinor: c.recoveredMinor,
      messageCount: c.messageCount,
      retryCount: c.retryCount,
      incentiveMinor: c.incentiveMinor,
      stopReason: c.stopReason,
      orderNumber: c.orderNumber,
      shopperName: c.shopperName,
      shopperEmail: c.shopperEmail,
      summary: diagnosis?.summary ?? null,
      basis: diagnosis?.basis ?? [],
      timeline: (timelines.get(c.id) ?? []).map((e) => ({ ...e, at: e.at.toISOString() })),
    };
  });

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Revenue recovery"
        description="Failed payments, abandoned baskets and shoppers whose payments keep failing — found, diagnosed and worked within limits you set. Revenue is only counted once a payment is actually captured."
      />
      <RecoveryBoard metrics={metrics} cases={board} />
    </div>
  );
}
