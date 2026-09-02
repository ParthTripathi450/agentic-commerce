"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { Check, ShieldCheck, X } from "lucide-react";
import { Alert, Badge, Button, Card, CardBody } from "@/components/ui";
import { ChatPanel, type ChatMessage } from "./chat-panel";
import type { TurnDto } from "@/server/agents/customer/dto";
import { StarDisplay } from "@/components/reviews/star-rating";
import { formatMoney } from "@/lib/money";
import type { AutonomousOutcome } from "@/server/agents/customer/autonomous";

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

type Awaiting = Extract<AutonomousOutcome, { status: "awaiting_authorization" }>;

type Phase =
  | { name: "idle" }
  | { name: "running" }
  | { name: "awaiting"; outcome: Awaiting }
  | { name: "stopped"; reason: string; details: string[]; step: string }
  | { name: "paying"; orderNumber: string }
  | { name: "paid"; orderNumber: string }
  | { name: "denied"; reason: string }
  | { name: "failed"; reason: string; checks?: string[] };

const STEPS = [
  "Understanding what you asked for",
  "Searching every merchant",
  "Ranking and choosing",
  "Signing the mandate chain",
];

const RAZORPAY_SRC = "https://checkout.razorpay.com/v1/checkout.js";

type ChatTurn = { role: "shopper" | "agent"; content: string };

export function AutonomousFlow({
  onExit,
  savedMethod,
}: {
  onExit: () => void;
  /** Description of the stored test method, or null to use the widget. */
  savedMethod: string | null;
}) {
  const [phase, setPhase] = useState<Phase>({ name: "idle" });

  /*
   * The conversation that precedes the purchase.
   *
   * The agent buys on one instruction, so the instruction had better be right.
   * It talks first — asking whatever it does not know — and only then commits
   * to a choice. `history` is the transcript the model reads; `messages` is
   * what the shopper sees.
   */
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [answered, setAnswered] = useState<string[]>([]);
  const [chips, setChips] = useState<{ label: string; value: string }[]>([]);
  const [chatting, setChatting] = useState(false);
  const [degraded, setDegraded] = useState(false);

  // Loaded up front: by the time the shopper clicks Allow, the widget must be
  // ready — fetching it then would stall the one moment that matters.
  useEffect(() => {
    if (window.Razorpay || document.querySelector(`script[src="${RAZORPAY_SRC}"]`)) return;
    const script = document.createElement("script");
    script.src = RAZORPAY_SRC;
    script.async = true;
    document.body.appendChild(script);
  }, []);

  /**
   * One conversational turn before the agent commits to anything.
   *
   * Reuses the assisted shopping endpoint purely to UNDERSTAND — it never buys.
   * When the agent has heard enough, the phrase it synthesised from the whole
   * conversation becomes the single instruction the autonomous run acts on, so
   * what it buys is what was actually discussed.
   */
  const send = useCallback(
    async function send(text: string, opts: { skipQuestions?: boolean } = {}) {
      const trimmed = text.trim();
      if (!trimmed && !opts.skipQuestions) return;

      if (trimmed) setMessages((m) => m.concat({ role: "shopper", content: trimmed }));
      setChips([]);
      setChatting(true);

      try {
        const response = await fetch("/api/agent/shop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: trimmed,
            answered,
            history,
            skipQuestions: opts.skipQuestions ?? false,
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          setPhase({ name: "failed", reason: data.error ?? "The agent could not understand that." });
          return;
        }

        const dto = data as TurnDto;
        setDegraded(Boolean(dto.provenance?.degraded));
        const nextHistory: ChatTurn[] = [...history, { role: "shopper", content: trimmed }];

        if (dto.outcome === "asking" && dto.question) {
          setMessages((m) =>
            m.concat({
              role: "agent",
              content: dto.question!.question,
              note: dto.question!.rationale || undefined,
            }),
          );
          setChips(dto.question.options);
          setAnswered((a) => [...a, dto.question!.id]);
          setHistory([...nextHistory, { role: "agent", content: dto.question.question }]);
          return;
        }

        // Understood enough — hand the synthesised instruction to the buyer.
        setHistory(nextHistory);
        const instruction =
          dto.intent?.productQuery ||
          nextHistory.filter((t) => t.role === "shopper").map((t) => t.content).join(", ");
        setMessages((m) =>
          m.concat({
            role: "agent",
            content: `Right — looking for ${instruction}. Let me find the best option and prepare the order.`,
          }),
        );
        await run(instruction);
      } catch {
        setPhase({ name: "failed", reason: "Could not reach the agent." });
      } finally {
        setChatting(false);
      }
    },
    [answered, history],
  );

  const resetConversation = useCallback(() => {
    setMessages([]);
    setHistory([]);
    setAnswered([]);
    setChips([]);
    setPhase({ name: "idle" });
  }, []);

  async function run(message: string) {
    if (!message.trim()) return;
    setPhase({ name: "running" });
    try {
      const response = await fetch("/api/agent/autonomous", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = await response.json();
      if (!response.ok) return setPhase({ name: "failed", reason: data.error });
      if (data.status === "stopped") {
        return setPhase({
          name: "stopped",
          reason: data.reason,
          details: data.details ?? [],
          step: data.step,
        });
      }
      setPhase({ name: "awaiting", outcome: data as Awaiting });
    } catch {
      setPhase({ name: "failed", reason: "Could not reach the agent." });
    }
  }

  async function decide(outcome: Awaiting, decision: "approve" | "reject") {
    if (decision === "reject") {
      setPhase({ name: "running" });
      const response = await fetch("/api/commerce/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalId: outcome.approvalId,
          decision: "reject",
          agentSessionId: outcome.sessionId,
        }),
      });
      const result = await response.json();
      return setPhase({ name: "denied", reason: result.reason ?? "Declined. Nothing was charged." });
    }

    setPhase({ name: "running" });

    // With a method on file the agent completes the purchase the shopper just
    // authorised, without asking them to type anything.
    if (savedMethod) {
      const saved = await (
        await fetch("/api/commerce/pay-saved", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            approvalId: outcome.approvalId,
            agentSessionId: outcome.sessionId,
          }),
        })
      ).json();

      if (saved.status === "paid") {
        return setPhase({ name: "paid", orderNumber: saved.orderNumber });
      }
      if (saved.status === "failed") {
        return setPhase({ name: "failed", reason: saved.reason, checks: saved.checks });
      }
      // needs_widget: fall through to the hosted checkout below.
    }

    const response = await fetch("/api/commerce/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approvalId: outcome.approvalId,
        decision: "approve",
        agentSessionId: outcome.sessionId,
      }),
    });
    const result = await response.json();

    if (result.status !== "authorized") {
      return setPhase({ name: "failed", reason: result.reason, checks: result.checks });
    }
    setPhase({ name: "paying", orderNumber: result.orderNumber });

    if (result.gateway === "mock" || !window.Razorpay) {
      return setPhase({
        name: "failed",
        reason: "The payment widget is unavailable. Nothing was charged.",
      });
    }

    const checkout = new window.Razorpay({
      key: result.gatewayKeyId,
      order_id: result.gatewayOrderId,
      amount: result.amountMinor,
      currency: result.currency,
      name: outcome.merchantName,
      description: outcome.selected.title,
      handler: async (rp: Record<string, string>) => {
        const confirmed = await (
          await fetch("/api/commerce/confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orderId: result.orderId,
              gatewayPaymentId: rp.razorpay_payment_id,
              signature: rp.razorpay_signature,
              agentSessionId: outcome.sessionId,
            }),
          })
        ).json();
        setPhase(
          confirmed.status === "paid"
            ? { name: "paid", orderNumber: confirmed.orderNumber }
            : { name: "failed", reason: confirmed.reason },
        );
      },
      modal: {
        ondismiss: () =>
          setPhase({ name: "failed", reason: "Payment window closed. You have not been charged." }),
      },
      theme: { color: "#7f56d9" },
    });
    checkout.open();
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-start gap-2.5">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" strokeWidth={2} />
            <p className="text-sm text-muted-foreground">
              The agent will search, compare, choose and prepare the whole order on its own. It
              stops before paying — you get one Allow or Deny, with its reasoning and the options
              it passed over.
            </p>
          </div>

          <div className="flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={onExit}>
              Cancel
            </Button>
          </div>
        </CardBody>
      </Card>

      {phase.name === "idle" || chatting ? (
        <ChatPanel
          messages={messages}
          chips={chips}
          pending={chatting}
          degraded={degraded}
          placeholder={
            messages.length === 0
              ? "e.g. I want shoes for a half marathon"
              : "Answer, or tell me anything else"
          }
          onSend={(text) => void send(text)}
          onSkip={() => void send("just pick something suitable", { skipQuestions: true })}
          onReset={resetConversation}
        />
      ) : null}

      {phase.name === "running" ? (
        <Card data-static="true">
          <CardBody className="space-y-2">
            {STEPS.map((step, index) => (
              <div key={step} className="flex items-center gap-2.5 text-sm text-muted-foreground">
                <span
                  className="size-1.5 animate-pulse rounded-full bg-primary"
                  style={{ animationDelay: `${index * 160}ms` }}
                />
                {step}
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {phase.name === "stopped" ? (
        <Alert tone="warning" title="The agent stopped before spending anything">
          {phase.reason}
          {phase.details.length > 0 ? (
            <ul className="mt-1.5 list-disc pl-4">
              {phase.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}

      {phase.name === "awaiting" ? (
        <AuthorizationScreen
          outcome={phase.outcome}
          savedMethod={savedMethod}
          onApprove={() => decide(phase.outcome, "approve")}
          onDeny={() => decide(phase.outcome, "reject")}
        />
      ) : null}

      {phase.name === "paying" ? (
        <Alert tone="info">
          Order {phase.orderNumber} created. Complete the payment in the Razorpay window.
        </Alert>
      ) : null}
      {phase.name === "paid" ? (
        <Alert tone="success" title="Bought">
          Order <span className="font-mono">{phase.orderNumber}</span> is confirmed. The mandate has
          been consumed so it cannot authorise another charge.
        </Alert>
      ) : null}
      {phase.name === "denied" ? <Alert tone="neutral">{phase.reason}</Alert> : null}
      {phase.name === "failed" ? (
        <Alert tone="danger" title="Not completed">
          {phase.reason}
          {phase.checks?.length ? (
            <ul className="mt-1.5 list-disc pl-4 font-mono text-xs">
              {phase.checks.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}
    </div>
  );
}

/** The single gate: what will be bought on the left, why on the right. */
function AuthorizationScreen({
  outcome,
  onApprove,
  onDeny,
  savedMethod,
}: {
  outcome: Awaiting;
  onApprove: () => void;
  onDeny: () => void;
  savedMethod: string | null;
}) {
  const { selected, totals } = outcome;

  return (
    <div className="grid animate-fade-up gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {/* ---------------------------------------------------- the decision */}
      <Card className="border-2 border-primary ring-2 ring-primary">
        <div className="-mt-(--card-spacing) mb-1 flex items-center gap-1.5 bg-primary px-5 py-1.5 text-xs font-semibold text-primary-foreground">
          <ShieldCheck className="size-3.5" strokeWidth={2.5} />
          Authorize this purchase
        </div>
        <CardBody className="space-y-4">
          <div className="flex gap-3">
            {selected.imageUrl ? (
              <Image
                src={selected.imageUrl}
                alt=""
                width={80}
                height={80}
                unoptimized
                className="size-20 shrink-0 rounded-lg border border-border object-cover"
              />
            ) : null}
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{selected.merchant.name}</p>
              <p className="text-sm font-semibold">{selected.title}</p>
              <p className="text-xs text-muted-foreground">
                {Object.entries(selected.variantAttributes)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(" · ")}
              </p>
              {selected.ratingBp ? (
                <div className="mt-1">
                  <StarDisplay stars={selected.ratingBp / 1000} count={selected.ratingCount} />
                </div>
              ) : null}
            </div>
          </div>

          <div className="rounded-lg bg-surface-2 p-3">
            <p className="text-xs text-muted-foreground">Total to pay</p>
            <p className="tabular mt-0.5 text-3xl font-semibold">
              {formatMoney(totals.totalMinor, totals.currency)}
            </p>
            <dl className="mt-2 space-y-0.5 text-xs text-muted-foreground">
              <Row label="Subtotal" value={formatMoney(totals.subtotalMinor, totals.currency)} />
              <Row
                label="Shipping"
                value={totals.shippingMinor === 0 ? "Free" : formatMoney(totals.shippingMinor)}
              />
              <Row label="GST (18%)" value={formatMoney(totals.taxMinor, totals.currency)} />
            </dl>
          </div>

          <div className="rounded-lg border border-border p-3">
            <p className="text-xs font-medium text-muted-foreground">Limits applied</p>
            <ul className="mt-1 space-y-0.5 text-xs text-subtle">
              {outcome.limitsSummary.map((limit) => (
                <li key={limit}>{limit}</li>
              ))}
              <li>{outcome.policyReason}</li>
            </ul>
            <p className="mt-2 font-mono text-[11px] text-subtle">
              cart {outcome.cartMandateId.slice(0, 8)} · intent{" "}
              {outcome.intentMandateId.slice(0, 8)}
            </p>
          </div>

          <div className="rounded-lg border border-border p-3">
            <p className="text-xs font-medium text-muted-foreground">Pays with</p>
            <p className="mt-0.5 text-sm">
              {savedMethod ?? "Razorpay checkout window (you enter the test card)"}
            </p>
            {savedMethod ? (
              <p className="mt-1 text-xs text-subtle">
                Fabricated test method. No real card, no real money — the charge runs through the
                mock gateway.
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="lg" onClick={onApprove} className="flex-1">
              <Check className="size-4" />
              Allow — pay {formatMoney(totals.totalMinor, totals.currency)}
            </Button>
            <Button size="lg" variant="secondary" onClick={onDeny}>
              <X className="size-4" />
              Deny
            </Button>
          </div>

          <p className="text-xs text-subtle">
            Razorpay test mode. Card 4100 2800 0000 1007, any future expiry, any CVV.
          </p>
        </CardBody>
      </Card>

      {/* ------------------------------------------- why, and what it beat */}
      <div className="space-y-3">
        <Card data-static="true">
          <CardBody>
            <p className="mb-2 text-xs font-semibold tracking-wide text-primary uppercase">
              Why the agent chose this
            </p>
            <ul className="space-y-2">
              {outcome.reasons.map((reason, index) => (
                <li key={index} className="flex gap-2.5 text-sm">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                  <span className="leading-relaxed">{reason}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>

        {outcome.alternatives.map((alt, index) => (
          <Card key={alt.option.variantId} data-static="true">
            <CardBody className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Badge>Runner-up #{index + 2}</Badge>
                <span className="tabular text-sm font-semibold">
                  {formatMoney(alt.option.priceMinor, alt.option.currency)}
                </span>
              </div>
              <div>
                <p className="text-sm font-medium">{alt.option.title}</p>
                <p className="text-xs text-muted-foreground">{alt.option.merchant.name}</p>
              </div>
              {alt.deltas.length > 0 ? (
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {alt.deltas.map((delta) => (
                    <li key={delta}>· {delta}</li>
                  ))}
                </ul>
              ) : null}
              <p className="text-[11px] text-subtle">{alt.summary}</p>
            </CardBody>
          </Card>
        ))}

        {outcome.excluded.length > 0 ? (
          <Card data-static="true">
            <CardBody>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                Ruled out before ranking
              </p>
              <ul className="space-y-1 text-xs text-subtle">
                {outcome.excluded.map((item, index) => (
                  <li key={index}>
                    <span className="text-foreground">{item.label}</span> — {item.reason}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt>{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}
