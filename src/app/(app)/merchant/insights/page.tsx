import { Badge, Card, CardBody, EmptyState } from "@/components/ui";
import { PageHeader } from "@/components/page-header";
import { InsightCard } from "@/components/merchant/insight-card";
import { RunReviewButton } from "@/components/merchant/run-review-button";
import { requireMerchant } from "@/lib/session";
import { listInsights } from "@/server/agents/merchant/agent";
import { providerStatus } from "@/server/ai/llm";

export default async function InsightsPage() {
  const { merchant } = await requireMerchant();
  const [open, resolved] = await Promise.all([
    listInsights(merchant.id, ["open"]),
    listInsights(merchant.id, ["executed", "dismissed"]),
  ]);
  const status = providerStatus();

  const counts = {
    critical: open.filter((i) => i.severity === "critical").length,
    warning: open.filter((i) => i.severity === "warning").length,
    info: open.filter((i) => i.severity === "info").length,
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Business insights"
        description="Findings computed from your own sales data. Every recommendation carries the evidence behind it, and nothing is applied to your store until you approve it."
        actions={<RunReviewButton />}
      />

      <div className="flex flex-wrap gap-2">
        <Badge tone="danger">{counts.critical} critical</Badge>
        <Badge tone="warning">{counts.warning} warning</Badge>
        <Badge tone="info">{counts.info} for review</Badge>
        {status.degradedMode ? (
          <Badge>Wording generated from templates — no AI provider configured</Badge>
        ) : null}
      </div>

      {open.length === 0 ? (
        <EmptyState title="No open recommendations">
          Run a review to analyse inventory, sales velocity and demand trends.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {open.map((insight) => (
            <InsightCard
              key={insight.id}
              insight={{
                id: insight.id,
                kind: insight.kind,
                severity: insight.severity,
                title: insight.title,
                explanation: insight.explanation,
                evidence: insight.evidence,
                recommendation: insight.recommendation,
                projectedImpact: insight.projectedImpact ?? null,
                status: insight.status,
                approvalId: insight.approvalId,
              }}
            />
          ))}
        </div>
      )}

      {resolved.length > 0 ? (
        <Card>
          <CardBody>
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Already decided
            </h2>
            <ul className="space-y-1.5">
              {resolved.slice(0, 10).map((insight) => (
                <li key={insight.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">{insight.title}</span>
                  <Badge tone={insight.status === "executed" ? "success" : "neutral"}>
                    {insight.status}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
