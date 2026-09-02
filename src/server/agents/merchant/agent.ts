import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { approvals, insights, inventory, productVariants, promotions } from "@/db/schema";
import { formatMoney } from "@/lib/money";
import { normalizeTypography } from "@/lib/text";
import { record, startSession } from "@/server/audit/recorder";
import { completeJson } from "@/server/ai/llm";
import { evaluatePolicy } from "@/server/policy/engine";
import { indexCatalog } from "@/server/catalog/indexer";
import { detectInsights, type DetectedInsight } from "./detectors";

/**
 * The merchant agent.
 *
 * It observes (detectors, deterministic), recommends (one grounded LLM call for
 * wording), and executes only what a human approved and the policy engine
 * allowed. It never changes a price, a promotion or stock on its own.
 */

const APPROVAL_TTL_MINUTES = 60 * 24 * 7;

const explanationSchema = z.object({
  explanations: z.array(z.object({ key: z.string(), text: z.string().max(600) })),
});

const SYSTEM = `You rewrite retail analytics findings as clear advice for a shop owner.

You are given findings that were computed from the merchant's real sales data, each with a key and the numbers behind it.

Strict rules:
- Use ONLY the numbers present in the finding. Never invent a figure, a cause, or a trend.
- Do not speculate about WHY demand changed — the data does not say.
- 2 to 3 sentences each. Direct, practical, second person ("your").
- Lead with what is happening, then the number that proves it, then what to do.
- Keep every quantity exactly as given. Currency amounts arrive already formatted
  (e.g. "₹6,998") — reproduce them character for character and never re-scale them.

Reply with JSON only: {"explanations":[{"key":"<the finding key>","text":"..."}]}`;

/**
 * Generates and stores insights.
 *
 * One LLM call covers every finding rather than one per insight — a merchant
 * with fifteen alerts would otherwise burn a free tier's minute-quota in a
 * single dashboard load.
 */
export async function generateInsights(input: { merchantId: string; userId: string }) {
  const sessionId = (
    await startSession({
      userId: input.userId,
      kind: "merchant",
      merchantId: input.merchantId,
      title: "Business review",
    })
  ).id;

  const startedAt = Date.now();
  const detected = await detectInsights(input.merchantId);

  await record(sessionId, {
    step: "ANALYZE",
    observation: {
      summary: `Reviewed inventory, sales velocity and demand trends; found ${detected.length} items worth attention.`,
      sources: ["orders", "order_items", "inventory", "product_variants", "products"],
      candidatesConsidered: detected.length,
    },
    reasoning: {
      summary: "Deterministic detectors over the merchant's own sales data — no model involved.",
      tradeoffs: detected.map((d) => `${d.kind}: ${d.title}`).join("; ") || undefined,
    },
    action: { type: "detect_insights" },
    outcome: { status: "ok", latencyMs: Date.now() - startedAt },
  });

  if (detected.length === 0) {
    return { sessionId, created: 0, insights: [] };
  }

  // Skip findings already open, so a daily review does not pile up duplicates.
  const existing = await db
    .select({ id: insights.id, recommendation: insights.recommendation, kind: insights.kind })
    .from(insights)
    .where(and(eq(insights.merchantId, input.merchantId), eq(insights.status, "open")));

  const existingKeys = new Set(
    existing.map((row) => {
      const params = (row.recommendation.params ?? {}) as Record<string, string>;
      return `${row.kind}:${params.variantId ?? params.productId ?? ""}`;
    }),
  );
  const fresh = detected.filter((d) => !existingKeys.has(d.dedupeKey));
  if (fresh.length === 0) return { sessionId, created: 0, insights: [] };

  const explanations = await explainFindings(fresh);

  const rows = await db
    .insert(insights)
    .values(
      fresh.map((finding) => ({
        merchantId: input.merchantId,
        sessionId,
        kind: finding.kind,
        severity: finding.severity,
        title: finding.title,
        explanation: explanations.get(finding.dedupeKey) ?? finding.baseExplanation,
        evidence: finding.evidence,
        recommendation: finding.recommendation,
        projectedImpact: finding.projectedImpact,
        status: "open" as const,
        // Nothing is auto-executable: every action needs a human decision.
        autoExecutable: false,
      })),
    )
    .returning();

  await record(sessionId, {
    step: "RECOMMEND",
    observation: { summary: `Produced ${rows.length} recommendations.` },
    reasoning: {
      summary: "Each recommendation carries the evidence it was derived from.",
      rejectedAlternatives: detected
        .filter((d) => existingKeys.has(d.dedupeKey))
        .map((d) => ({ ref: d.dedupeKey, label: d.title, reason: "Already open from a previous review." })),
    },
    action: { type: "create_insights", params: { count: rows.length } },
    outcome: { status: "ok" },
  });

  return { sessionId, created: rows.length, insights: rows };
}

/**
 * Money is stored in minor units (paise) but must never reach the model as a
 * bare integer: it will echo 699800 as "699,800 in revenue" when the real figure
 * is ₹6,998. Any key ending in "Minor" is formatted and renamed before sending.
 */
function toDisplayEvidence(evidence: Record<string, unknown>): Record<string, unknown> {
  const display: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (key.endsWith("Minor") && typeof value === "number") {
      display[key.replace(/Minor$/, "")] = formatMoney(value);
    } else {
      display[key] = value;
    }
  }
  return display;
}

/** One grounded LLM call for all findings; falls back to the computed wording. */
async function explainFindings(findings: DetectedInsight[]): Promise<Map<string, string>> {
  const payload = findings.map((f) => ({
    key: f.dedupeKey,
    finding: f.title,
    evidence: toDisplayEvidence(f.evidence),
    suggestedAction: f.recommendation.type,
    projectedImpact: f.projectedImpact
      ? {
          ...f.projectedImpact,
          valueMinor: undefined,
          value:
            f.projectedImpact.valueMinor !== undefined
              ? formatMoney(f.projectedImpact.valueMinor)
              : f.projectedImpact.value,
        }
      : undefined,
  }));

  try {
    const { value } = await completeJson(
      {
        task: "merchant_insight",
        system: SYSTEM,
        messages: [{ role: "user", content: JSON.stringify(payload, null, 2) }],
        temperature: 0.2,
        maxTokens: 1600,
        reasoningEffort: "low",
        fallback: () =>
          JSON.stringify({
            explanations: findings.map((f) => ({ key: f.dedupeKey, text: f.baseExplanation })),
          }),
      },
      (raw) => explanationSchema.parse(raw),
    );
    return new Map(value.explanations.map((e) => [e.key, normalizeTypography(e.text)]));
  } catch {
    // Wording is a nicety; the finding itself is what matters.
    return new Map(findings.map((f) => [f.dedupeKey, f.baseExplanation]));
  }
}

export type ProposalResult =
  | { status: "requires_approval"; approvalId: string; summary: string; reason: string; boundsChecked: string[] }
  | { status: "denied"; reason: string; violations: string[] }
  | { status: "not_executable"; reason: string };

/**
 * Turns a recommendation into an approval request.
 *
 * The policy engine decides whether the action is even permissible before a
 * human is asked, so an out-of-bounds suggestion is refused with its reason
 * rather than presented as if it were available.
 */
export async function proposeInsightAction(input: {
  insightId: string;
  userId: string;
  merchantId: string;
}): Promise<ProposalResult> {
  const [insight] = await db
    .select()
    .from(insights)
    .where(and(eq(insights.id, input.insightId), eq(insights.merchantId, input.merchantId)))
    .limit(1);
  if (!insight) return { status: "not_executable", reason: "That recommendation no longer exists." };
  if (insight.status !== "open") {
    return { status: "not_executable", reason: `This recommendation is already ${insight.status}.` };
  }

  const action = insight.recommendation;
  const params = (action.params ?? {}) as Record<string, number | string>;

  if (action.type === "merchant_enrich_listing") {
    return {
      status: "not_executable",
      reason: "Improving a listing needs your own product knowledge — the agent will not write it for you.",
    };
  }

  const decision = await evaluatePolicy(
    action.type === "merchant_availability"
      ? { type: "merchant_availability", enable: Boolean(params.enable) }
      : action.type === "merchant_restock"
      ? {
          type: "merchant_restock",
          units: Number(params.units ?? 0),
          costMinor: await estimateRestockCost(String(params.variantId ?? ""), Number(params.units ?? 0)),
        }
      : { type: "merchant_discount", bp: Number(params.bp ?? 0) },
    { userId: input.userId, merchantId: input.merchantId },
  );

  const sessionId =
    insight.sessionId ??
    (await startSession({ userId: input.userId, kind: "merchant", merchantId: input.merchantId })).id;

  await record(sessionId, {
    step: "POLICY_CHECK",
    observation: { summary: `Checked "${insight.title}" against merchant action limits.`, inputs: { action } },
    reasoning: { summary: decision.reason },
    action: { ...action, verdict: decision.verdict, boundsChecked: decision.boundsChecked },
    outcome: { status: decision.verdict === "DENY" ? "blocked" : "ok", detail: decision.reason },
  });

  if (decision.verdict === "DENY") {
    return {
      status: "denied",
      reason: decision.reason,
      violations: decision.violations.map((v) => v.message),
    };
  }

  const summary = describeAction(action, insight.title);
  const [approval] = await db
    .insert(approvals)
    .values({
      sessionId,
      userId: input.userId,
      merchantId: input.merchantId,
      action: { ...action, verdict: decision.verdict, boundsChecked: decision.boundsChecked, requiresApproval: true },
      summary,
      verdict: decision.verdict,
      reason: decision.reason,
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MINUTES * 60_000),
    })
    .returning();

  await db
    .update(insights)
    .set({ approvalId: approval.id, updatedAt: new Date() })
    .where(eq(insights.id, insight.id));

  return {
    status: "requires_approval",
    approvalId: approval.id,
    summary,
    reason: decision.reason,
    boundsChecked: decision.boundsChecked,
  };
}

export type ExecutionResult =
  | { status: "executed"; detail: string }
  | { status: "rejected"; detail: string }
  | { status: "failed"; detail: string };

/** Performs an approved action. Bounds were already checked at proposal time. */
export async function decideInsightAction(input: {
  approvalId: string;
  userId: string;
  merchantId: string;
  decision: "approve" | "reject";
  note?: string;
}): Promise<ExecutionResult> {
  const [approval] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, input.approvalId), eq(approvals.merchantId, input.merchantId)))
    .limit(1);
  if (!approval) return { status: "failed", detail: "Approval not found." };
  if (approval.status !== "pending") {
    return { status: "failed", detail: `This request was already ${approval.status}.` };
  }
  if (approval.expiresAt < new Date()) {
    await db.update(approvals).set({ status: "expired" }).where(eq(approvals.id, approval.id));
    return { status: "failed", detail: "This request expired. Run a new review." };
  }

  const [insight] = await db
    .select()
    .from(insights)
    .where(eq(insights.approvalId, approval.id))
    .limit(1);

  if (input.decision === "reject") {
    await db
      .update(approvals)
      .set({ status: "rejected", decidedBy: input.userId, decidedAt: new Date(), decisionNote: input.note })
      .where(eq(approvals.id, approval.id));
    if (insight) {
      await db
        .update(insights)
        .set({ status: "dismissed", dismissedReason: input.note ?? "Declined by merchant", updatedAt: new Date() })
        .where(eq(insights.id, insight.id));
    }
    if (approval.sessionId) {
      await record(approval.sessionId, {
        step: "EXECUTE",
        observation: { summary: `Merchant declined: ${approval.summary}` },
        reasoning: { summary: "No change made." },
        action: { ...approval.action, verdict: "DENY" },
        outcome: { status: "blocked", detail: "declined by merchant" },
      });
    }
    return { status: "rejected", detail: "Recommendation dismissed. Nothing changed." };
  }

  const params = (approval.action.params ?? {}) as Record<string, string | number>;
  let detail: string;

  try {
    if (approval.action.type === "merchant_restock") {
      const units = Number(params.units ?? 0);
      const variantId = String(params.variantId ?? "");
      await db
        .update(inventory)
        .set({ quantity: sql`${inventory.quantity} + ${units}`, updatedAt: new Date() })
        .where(eq(inventory.variantId, variantId));
      detail = `Added ${units} units to ${params.sku ?? variantId}.`;
    } else if (approval.action.type === "merchant_discount") {
      const bp = Number(params.bp ?? 0);
      await db.insert(promotions).values({
        merchantId: input.merchantId,
        title: String(params.title ?? "Agent-recommended promotion"),
        type: "percentage_off",
        value: bp,
        conditions: params.productId ? { productIds: [String(params.productId)] } : {},
        active: true,
        activeFrom: new Date(),
        activeTo: new Date(Date.now() + 14 * 24 * 3600_000),
        createdByAgent: true,
      });
      detail = `Created a ${(bp / 100).toFixed(0)}% promotion, active for 14 days.`;
    } else if (approval.action.type === "merchant_availability") {
      const enable = Boolean(params.enable);
      await db
        .update(productVariants)
        .set({ active: enable, updatedAt: new Date() })
        .where(eq(productVariants.id, String(params.variantId ?? "")));
      // Withdrawing changes what agents can find, so the catalog is rebuilt.
      const [row] = await db
        .select({ productId: productVariants.productId })
        .from(productVariants)
        .where(eq(productVariants.id, String(params.variantId ?? "")))
        .limit(1);
      if (row) await indexCatalog({ productIds: [row.productId], force: true });
      detail = enable
        ? `${params.sku ?? "Variant"} is available for sale again.`
        : `${params.sku ?? "Variant"} withdrawn from sale and removed from agent search.`;
    } else {
      return { status: "failed", detail: `Cannot execute action type ${approval.action.type}.` };
    }
  } catch (cause) {
    if (approval.sessionId) {
      await record(approval.sessionId, {
        step: "EXECUTE",
        observation: { summary: `Attempted: ${approval.summary}` },
        reasoning: { summary: "Execution raised an error; no change was applied." },
        action: approval.action,
        outcome: { status: "error", detail: (cause as Error).message },
      });
    }
    return { status: "failed", detail: `Could not apply the change: ${(cause as Error).message}` };
  }

  await db
    .update(approvals)
    .set({ status: "approved", decidedBy: input.userId, decidedAt: new Date(), decisionNote: input.note })
    .where(eq(approvals.id, approval.id));

  if (insight) {
    await db
      .update(insights)
      .set({ status: "executed", executedAt: new Date(), updatedAt: new Date() })
      .where(eq(insights.id, insight.id));
  }

  if (approval.sessionId) {
    await record(approval.sessionId, {
      step: "EXECUTE",
      observation: { summary: `Merchant approved: ${approval.summary}` },
      reasoning: { summary: "Executed within the approved bounds.", tradeoffs: approval.reason },
      action: { ...approval.action, verdict: "ALLOW", approvalId: approval.id },
      outcome: { status: "ok", detail },
    });
  }

  return { status: "executed", detail };
}

async function estimateRestockCost(variantId: string, units: number): Promise<number> {
  if (!variantId || units <= 0) return 0;
  const [variant] = await db
    .select({ price: productVariants.priceMinor })
    .from(productVariants)
    .where(eq(productVariants.id, variantId))
    .limit(1);
  // Cost of goods is not modelled; approximate at 60% of retail.
  return Math.round((variant?.price ?? 0) * units * 0.6);
}

function describeAction(action: { type: string; params?: Record<string, unknown> }, title: string) {
  const params = (action.params ?? {}) as Record<string, string | number>;
  if (action.type === "merchant_restock") {
    return `Add ${params.units} units of ${params.sku ?? "this variant"} to stock — ${title}`;
  }
  if (action.type === "merchant_discount") {
    return `Run a ${(Number(params.bp ?? 0) / 100).toFixed(0)}% promotion for 14 days — ${title}`;
  }
  if (action.type === "merchant_availability") {
    return params.enable
      ? `Make ${params.sku ?? "this variant"} available for sale again — ${title}`
      : `Withdraw ${params.sku ?? "this variant"} from sale — ${title}`;
  }
  return title;
}

export async function listInsights(merchantId: string, statuses: string[] = ["open"]) {
  return db
    .select()
    .from(insights)
    .where(
      and(
        eq(insights.merchantId, merchantId),
        inArray(insights.status, statuses as ("open" | "approved" | "executed" | "dismissed" | "expired")[]),
      ),
    )
    .orderBy(insights.severity, insights.createdAt);
}

export { formatMoney };
