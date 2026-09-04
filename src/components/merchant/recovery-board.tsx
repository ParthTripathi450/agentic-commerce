"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, Check, Play, ShieldAlert, X } from "lucide-react";
import { Alert, Badge, Button, Card, CardBody, EmptyState, type Tone } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { decideRecoveryAction, runSweepAction, stopRecoveryAction } from "@/server/agents/recovery/actions";

export type BoardCase = {
  id: string;
  scenario: string;
  state: string;
  diagnosis: string | null;
  amountAtRiskMinor: number;
  recoveredMinor: number;
  messageCount: number;
  retryCount: number;
  incentiveMinor: number;
  stopReason: string | null;
  orderNumber: string | null;
  shopperEmail: string;
  summary: string | null;
  basis: string[];
  /** Every step the agent took on this case, oldest first. */
  timeline: {
    step: string;
    summary: string;
    reasoning: string;
    detail: string;
    status: string;
    at: string;
  }[];
};

export type BoardMetrics = {
  openCases: number;
  atRiskMinor: number;
  recoveredCases: number;
  recoveredMinor: number;
  escalatedCases: number;
  stoppedCases: number;
  awaitingCases: number;
  totalCases: number;
  recoveryRate: number | null;
};

const STATE: Record<string, { tone: Tone; label: string }> = {
  detected: { tone: "neutral", label: "Detected" },
  diagnosed: { tone: "info", label: "Diagnosed" },
  awaiting_approval: { tone: "warning", label: "Needs your approval" },
  acting: { tone: "info", label: "Acting" },
  verifying: { tone: "info", label: "Contacted — waiting" },
  recovered: { tone: "success", label: "Recovered" },
  stopped: { tone: "neutral", label: "Stopped" },
  escalated: { tone: "warning", label: "Escalated to you" },
  expired: { tone: "neutral", label: "Expired" },
};

const SCENARIO: Record<string, string> = {
  failed_payment: "Failed payment",
  abandoned_checkout: "Abandoned basket",
  payment_degradation: "Repeated failures",
  failed_subscription: "Failed subscription",
  overdue_invoice: "Overdue invoice",
};

/**
 * The recovery board.
 *
 * Built around the two numbers that decide whether this agent is worth running:
 * what is at risk, and what actually came back. Everything else on the page
 * exists to make those two arguable — the diagnosis it reached, the evidence it
 * reached it from, and why it stopped where it did.
 */
export function RecoveryBoard({
  metrics,
  cases,
}: {
  metrics: BoardMetrics;
  cases: BoardCase[];
}) {
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);

  const act = (fn: () => Promise<{ ok?: true; message?: string; error?: string }>) =>
    startTransition(async () => {
      const result = await fn();
      setNotice(result.error ?? result.message ?? null);
    });

  return (
    <div className="space-y-5">
      <Card>
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-4">
            <Figure
              label="At risk now"
              value={formatMoney(metrics.atRiskMinor)}
              hint={`${metrics.openCases} open case${metrics.openCases === 1 ? "" : "s"}`}
              tone="warning"
            />
            <Figure
              label="Recovered"
              value={formatMoney(metrics.recoveredMinor)}
              hint={`${metrics.recoveredCases} case${metrics.recoveredCases === 1 ? "" : "s"}, counted from captured payments only`}
              tone="success"
            />
            <Figure
              label="Recovery rate"
              value={metrics.recoveryRate === null ? "—" : `${Math.round(metrics.recoveryRate * 100)}%`}
              hint="of cases that reached an end"
            />
            <Figure
              label="Handed to you"
              value={String(metrics.escalatedCases + metrics.awaitingCases)}
              hint="escalated or awaiting approval"
              tone={metrics.escalatedCases + metrics.awaitingCases > 0 ? "warning" : "neutral"}
            />
          </div>

          {notice ? <Alert tone="info">{notice}</Alert> : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => act(runSweepAction)} disabled={pending}>
              <Play className="size-4" />
              {pending ? "Running…" : "Run a recovery sweep"}
            </Button>
            <p className="text-xs text-subtle">
              Safe to run as often as you like — each case advances one step, and nothing already
              handled is picked up again.
            </p>
          </div>
        </CardBody>
      </Card>

      {cases.length === 0 ? (
        <EmptyState title="No revenue at risk found">
          Run a sweep to look for failed payments, abandoned baskets and shoppers whose payments keep
          failing.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {cases.map((item) => (
            <Card key={item.id}>
              <CardBody className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={STATE[item.state]?.tone ?? "neutral"}>
                        {STATE[item.state]?.label ?? item.state}
                      </Badge>
                      <span className="text-sm font-medium">
                        {SCENARIO[item.scenario] ?? item.scenario}
                      </span>
                      {item.orderNumber ? (
                        <span className="font-mono text-xs text-muted-foreground">
                          {item.orderNumber}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{item.shopperEmail}</p>
                  </div>
                  <div className="text-right">
                    <p className="tabular text-base font-semibold">
                      {formatMoney(item.amountAtRiskMinor)}
                    </p>
                    {item.recoveredMinor > 0 ? (
                      <p className="tabular text-xs text-success">
                        {formatMoney(item.recoveredMinor)} recovered
                      </p>
                    ) : null}
                  </div>
                </div>

                {/*
                  * The reasoning, not just the verdict.
                  *
                  * A merchant asked to approve spending money on a shopper is
                  * owed what the agent concluded AND what it concluded that
                  * from, or the approval is a rubber stamp.
                  */}
                {item.summary ? (
                  <div className="rounded-lg border border-border p-2.5">
                    <p className="text-sm">{item.summary}</p>
                    {item.basis.length > 0 ? (
                      <ul className="mt-1.5 space-y-0.5">
                        {item.basis.map((b, i) => (
                          <li key={i} className="text-xs text-muted-foreground">
                            · {b}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}

                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-subtle">
                  <span>{item.messageCount} message(s) sent</span>
                  <span>{item.retryCount} retry link(s)</span>
                  {item.incentiveMinor > 0 ? (
                    <span>{formatMoney(item.incentiveMinor)} discounted</span>
                  ) : null}
                </div>

                {item.stopReason ? (
                  <p className="flex items-start gap-1.5 rounded-lg bg-surface-2 p-2.5 text-xs">
                    {item.state === "escalated" ? (
                      <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
                    ) : (
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    <span>{item.stopReason}</span>
                  </p>
                ) : null}

                {item.state === "awaiting_approval" ? (
                  <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                    <Button size="sm" disabled={pending} onClick={() => act(() => decideRecoveryAction(item.id, "approve"))}>
                      <Check className="size-3.5" />
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pending}
                      onClick={() => act(() => decideRecoveryAction(item.id, "reject"))}
                    >
                      <X className="size-3.5" />
                      Decline
                    </Button>
                  </div>
                ) : null}

                {/*
                  * The audit trail, in the agent's own steps.
                  *
                  * Collapsed because most of the time the verdict is enough —
                  * but one click away, because the moment a merchant disagrees
                  * with a decision this is the only thing that settles it.
                  */}
                {item.timeline.length > 0 ? <Timeline entries={item.timeline} /> : null}

                {!["recovered", "stopped", "escalated", "expired"].includes(item.state) ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => act(() => stopRecoveryAction(item.id, "Closed by the merchant."))}
                    className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                  >
                    Stop working this case
                  </button>
                ) : null}
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

const STEP_TONE: Record<string, string> = {
  DETECT: "text-muted-foreground",
  DIAGNOSE: "text-primary",
  RECOMMEND: "text-primary",
  POLICY_CHECK: "text-warning",
  EXECUTE: "text-foreground",
  VERIFY: "text-success",
};

function Timeline({ entries }: { entries: BoardCase["timeline"] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-t border-border pt-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-xs text-primary underline underline-offset-4 hover:text-primary/80"
      >
        {open ? "Hide" : `Audit trail (${entries.length} step${entries.length === 1 ? "" : "s"})`}
      </button>

      {open ? (
        <ol className="mt-2 space-y-2">
          {entries.map((e, i) => (
            <li key={i} className="border-l-2 border-border pl-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span
                  className={cn(
                    "font-mono text-[11px] font-semibold tracking-wide",
                    STEP_TONE[e.step] ?? "text-muted-foreground",
                  )}
                >
                  {e.step}
                </span>
                <span className="text-[11px] text-subtle">
                  {new Date(e.at).toLocaleString("en-IN", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                {e.status !== "ok" ? <Badge tone="warning">{e.status}</Badge> : null}
              </div>
              {e.summary ? <p className="mt-0.5 text-xs">{e.summary}</p> : null}
              {/* Why, not just what — the part an approval rests on. */}
              {e.reasoning ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{e.reasoning}</p>
              ) : null}
              {e.detail && e.detail !== e.summary ? (
                <p className="mt-0.5 font-mono text-[11px] text-subtle">{e.detail}</p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function Figure({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint: string;
  tone?: Tone;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "tabular mt-0.5 text-2xl font-semibold",
          tone === "success" && "text-success",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 text-xs text-subtle">{hint}</p>
    </div>
  );
}
