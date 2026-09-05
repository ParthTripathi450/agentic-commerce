import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentEvents, recoveryCases } from "@/db/schema";

/** Reads only — mutations live in `actions.ts`, per the project's split. */

export type CaseRow = typeof recoveryCases.$inferSelect & {
  orderNumber: string | null;
  shopperName: string;
  shopperEmail: string;
};

export async function listCases(merchantId: string, limit = 50): Promise<CaseRow[]> {
  const rows = (await db.execute(sql`
    SELECT rc.*, o.order_number, u.name AS shopper_name, u.email AS shopper_email
    FROM recovery_cases rc
    LEFT JOIN orders o ON o.id = rc.order_id
    JOIN users u ON u.id = rc.user_id
    WHERE rc.merchant_id = ${merchantId}
    ORDER BY
      -- Live cases first, then by money: the merchant's attention is the
      -- scarce resource this page is spending.
      CASE WHEN rc.state IN ('recovered','stopped','escalated','expired') THEN 1 ELSE 0 END,
      rc.amount_at_risk_minor DESC
    LIMIT ${limit}
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    ...(r as unknown as typeof recoveryCases.$inferSelect),
    id: String(r.id),
    orderNumber: r.order_number ? String(r.order_number) : null,
    shopperName: String(r.shopper_name ?? "").trim(),
    shopperEmail: String(r.shopper_email),
    amountAtRiskMinor: Number(r.amount_at_risk_minor),
    recoveredMinor: Number(r.recovered_minor ?? 0),
    messageCount: Number(r.message_count ?? 0),
    retryCount: Number(r.retry_count ?? 0),
    incentiveMinor: Number(r.incentive_minor ?? 0),
    stopReason: r.stop_reason ? String(r.stop_reason) : null,
    createdAt: new Date(String(r.created_at)),
  })) as CaseRow[];
}

export type TimelineEntry = {
  step: string;
  summary: string;
  reasoning: string;
  detail: string;
  status: string;
  at: Date;
};

/**
 * The audit trail for every case on the page, in ONE query.
 *
 * Per-case fetching meant fifty round trips to render a dashboard, and a
 * timeline nobody waits for is a timeline nobody reads. Grouped by the
 * `caseId` each event carries in its action params.
 */
export async function timelinesFor(
  merchantId: string,
): Promise<Map<string, TimelineEntry[]>> {
  const rows = (await db.execute(sql`
    SELECT ae.step, ae.observation, ae.reasoning, ae.action, ae.outcome, ae.created_at
    FROM agent_events ae
    WHERE ae.session_id IN (
      SELECT DISTINCT session_id FROM recovery_cases
      WHERE merchant_id = ${merchantId} AND session_id IS NOT NULL
    )
    ORDER BY ae.sequence ASC
    LIMIT 800
  `)) as unknown as Record<string, unknown>[];

  const byCase = new Map<string, TimelineEntry[]>();
  for (const r of rows) {
    const action = r.action as { params?: { caseId?: string } };
    const caseId = action?.params?.caseId;
    // Sweep-level entries belong to no single case and are shown on none.
    if (!caseId) continue;

    const entry: TimelineEntry = {
      step: String(r.step),
      summary: String((r.observation as { summary?: string })?.summary ?? ""),
      reasoning: String((r.reasoning as { summary?: string })?.summary ?? ""),
      detail: String((r.outcome as { detail?: string })?.detail ?? ""),
      status: String((r.outcome as { status?: string })?.status ?? "ok"),
      at: new Date(String(r.created_at)),
    };
    byCase.set(caseId, [...(byCase.get(caseId) ?? []), entry]);
  }
  return byCase;
}

/**
 * The audit trail for one case, oldest first.
 *
 * Read from `agent_events` rather than reconstructed from the case row: the
 * row is the current state, the events are what actually happened, and a
 * timeline built from the former would show only the last thing the agent
 * thought.
 */
export async function caseTimeline(caseId: string) {
  const [row] = await db
    .select({ sessionId: recoveryCases.sessionId })
    .from(recoveryCases)
    .where(eq(recoveryCases.id, caseId))
    .limit(1);
  if (!row?.sessionId) return [];

  const events = await db
    .select()
    .from(agentEvents)
    .where(eq(agentEvents.sessionId, row.sessionId))
    .orderBy(desc(agentEvents.sequence))
    .limit(60);

  // Only the entries about this case, plus the sweep-level ones that have no
  // case of their own.
  return events
    .filter((e) => {
      const params = (e.action as { params?: { caseId?: string } })?.params;
      return !params?.caseId || params.caseId === caseId;
    })
    .reverse();
}
