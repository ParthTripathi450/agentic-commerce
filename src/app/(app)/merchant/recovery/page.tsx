import { PageHeader } from "@/components/page-header";
import { RecoveryBoard, type BoardCase } from "@/components/merchant/recovery-board";
import { requireMerchant } from "@/lib/session";
import { recoveryMetrics } from "@/server/agents/recovery/agent";
import { RecoveryFilters } from "@/components/merchant/recovery-filters";
import { listCases, summarise, timelinesFor } from "@/server/agents/recovery/queries";

/**
 * Revenue recovery, for the merchant.
 *
 * The page a merchant judges the agent by, so it leads with the two numbers
 * that decide whether it is worth running — what is at risk, and what actually
 * came back — and shows the reasoning behind every case rather than only its
 * verdict.
 */
type Params = Record<string, string | string[] | undefined>;

/**
 * Query strings are user input like any other.
 *
 * A bad number is dropped rather than reaching SQL as NaN, which would silently
 * match nothing and read as "you have no cases" — the worst possible lie for
 * this particular page to tell.
 */
const CASE_STATES = new Set([
  "detected", "diagnosed", "awaiting_approval", "acting",
  "verifying", "recovered", "stopped", "escalated", "expired",
]);

function parseFilters(params: Params) {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
  const num = (v: string | string[] | undefined) => {
    const n = Number(one(v));
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
  };
  return {
    q: one(params.q)?.slice(0, 120),
    minAmountMinor: num(params.min),
    withinHours: num(params.within),
    // `state` is compared against a Postgres ENUM, so an unrecognised value
    // does not return nothing — it raises. Unknown states are dropped.
    state: CASE_STATES.has(one(params.state) ?? "") ? one(params.state) : undefined,
  };
}

export default async function RecoveryPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { merchant } = await requireMerchant();
  const filters = parseFilters(await searchParams);

  const [metrics, cases, timelines] = await Promise.all([
    recoveryMetrics(merchant.id),
    listCases(merchant.id, filters),
    timelinesFor(merchant.id),
  ]);
  const shown = summarise(cases);

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
      <RecoveryBoard
        metrics={metrics}
        cases={board}
        filters={
          <RecoveryFilters
            shown={shown.shown}
            atRiskMinor={shown.atRiskMinor}
            recoveredMinor={shown.recoveredMinor}
          />
        }
      />
    </div>
  );
}
