"use client";

import { useState } from "react";
import { Alert, Badge, Button, Card, CardBody, type Tone } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { decideAction, proposeAction } from "@/server/agents/merchant/actions";

type Insight = {
  id: string;
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  explanation: string;
  evidence: Record<string, unknown>;
  recommendation: { type: string; params?: Record<string, unknown> };
  projectedImpact: {
    metric: string;
    valueMinor?: number;
    value?: number;
    confidence: "low" | "medium" | "high";
    basis: string;
  } | null;
  status: string;
  approvalId: string | null;
};

const SEVERITY: Record<Insight["severity"], { tone: Tone; label: string }> = {
  critical: { tone: "danger", label: "Critical" },
  warning: { tone: "warning", label: "Warning" },
  info: { tone: "info", label: "For review" },
};

const CONFIDENCE: Record<"low" | "medium" | "high", Tone> = {
  high: "success",
  medium: "info",
  low: "neutral",
};

type Phase =
  | { name: "idle" }
  | { name: "working" }
  | { name: "awaiting"; approvalId: string; summary: string; reason: string; bounds: string[] }
  | { name: "denied"; reason: string; violations: string[] }
  | { name: "blocked"; reason: string }
  | { name: "done"; detail: string; tone: Tone };

export function InsightCard({ insight }: { insight: Insight }) {
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const severity = SEVERITY[insight.severity];

  async function propose() {
    setPhase({ name: "working" });
    const result = await proposeAction(insight.id);
    if (result.status === "requires_approval") {
      setPhase({
        name: "awaiting",
        approvalId: result.approvalId,
        summary: result.summary,
        reason: result.reason,
        bounds: result.boundsChecked,
      });
    } else if (result.status === "denied") {
      setPhase({ name: "denied", reason: result.reason, violations: result.violations });
    } else {
      setPhase({ name: "blocked", reason: result.reason });
    }
  }

  async function decide(approvalId: string, decision: "approve" | "reject") {
    setPhase({ name: "working" });
    const result = await decideAction(approvalId, decision);
    setPhase({
      name: "done",
      detail: result.detail,
      tone: result.status === "executed" ? "success" : result.status === "rejected" ? "neutral" : "danger",
    });
  }

  return (
    <Card className="animate-fade-up">
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={severity.tone}>{severity.label}</Badge>
              <Badge>{insight.kind.replace(/_/g, " ")}</Badge>
            </div>
            <h3 className="mt-1.5 text-sm font-semibold">{insight.title}</h3>
          </div>
        </div>

        <p className="text-sm leading-relaxed text-muted-foreground">{insight.explanation}</p>

        {insight.projectedImpact ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
            <span className="text-xs text-muted-foreground">{insight.projectedImpact.metric}:</span>
            <span className="tabular text-sm font-semibold">
              {insight.projectedImpact.valueMinor !== undefined
                ? formatMoney(insight.projectedImpact.valueMinor)
                : insight.projectedImpact.value}
            </span>
            <Badge tone={CONFIDENCE[insight.projectedImpact.confidence]}>
              {insight.projectedImpact.confidence} confidence
            </Badge>
            <span className="w-full text-xs text-subtle">{insight.projectedImpact.basis}</span>
          </div>
        ) : null}

        <details className="group">
          <summary className="cursor-pointer text-xs font-medium text-primary hover:underline">
            Show the evidence behind this
          </summary>
          <dl className="mt-2 grid gap-1 rounded-lg bg-surface-2 p-3 text-xs sm:grid-cols-2">
            {Object.entries(insight.evidence).map(([key, value]) => (
              <div key={key} className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{key.replace(/([A-Z])/g, " $1").toLowerCase()}</dt>
                <dd className="tabular font-medium">
                  {key.endsWith("Minor") && typeof value === "number"
                    ? formatMoney(value)
                    : String(value)}
                </dd>
              </div>
            ))}
          </dl>
        </details>

        {phase.name === "idle" && insight.status === "open" ? (
          <div className="flex gap-2 border-t border-border pt-3">
            <Button size="sm" onClick={propose}>
              Review this action
            </Button>
          </div>
        ) : null}

        {phase.name === "working" ? <p className="text-xs text-muted-foreground">Working…</p> : null}

        {phase.name === "awaiting" ? (
          <div className="space-y-2 rounded-lg border border-primary bg-primary-soft/40 p-3">
            <p className="text-sm font-medium">{phase.summary}</p>
            <p className="text-xs text-muted-foreground">{phase.reason}</p>
            <p className="font-mono text-[11px] text-subtle">
              limits checked: {phase.bounds.join(", ") || "none"}
            </p>
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={() => decide(phase.approvalId, "approve")}>
                Approve and apply
              </Button>
              <Button size="sm" variant="secondary" onClick={() => decide(phase.approvalId, "reject")}>
                Dismiss
              </Button>
            </div>
          </div>
        ) : null}

        {phase.name === "denied" ? (
          <Alert tone="danger" title="Blocked by your action limits">
            {phase.reason}
            {phase.violations.length ? (
              <ul className="mt-1 list-disc pl-4">
                {phase.violations.map((v) => (
                  <li key={v}>{v}</li>
                ))}
              </ul>
            ) : null}
          </Alert>
        ) : null}

        {phase.name === "blocked" ? <Alert tone="info">{phase.reason}</Alert> : null}
        {phase.name === "done" ? <Alert tone={phase.tone}>{phase.detail}</Alert> : null}
      </CardBody>
    </Card>
  );
}
