import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentEvents, recoveryCases } from "@/db/schema";

/** Reads only — mutations live in `actions.ts`, per the project's split. */

export type CaseRow = typeof recoveryCases.$inferSelect & {
  orderNumber: string | null;
  shopperEmail: string;
};

export async function listCases(merchantId: string, limit = 50): Promise<CaseRow[]> {
  const rows = (await db.execute(sql`
    SELECT rc.*, o.order_number, u.email AS shopper_email
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
