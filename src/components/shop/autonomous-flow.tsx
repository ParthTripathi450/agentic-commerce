"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { WIDGET_UNAVAILABLE, loadRazorpayWidget } from "@/lib/razorpay-widget";
import { useRouter } from "next/navigation";
import { Check, ShieldCheck, ShoppingCart, X } from "lucide-react";
import { Alert, Badge, Button, Card, CardBody } from "@/components/ui";
import { ChatPanel, type ChatMessage } from "./chat-panel";
import { AlsoLike } from "./also-like";
import { addToCartAction } from "@/server/commerce/cart-actions";
import type { TurnDto } from "@/server/agents/customer/dto";
import { StarDisplay } from "@/components/reviews/star-rating";
import { formatMoney } from "@/lib/money";
import type { AutonomousOutcome } from "@/server/agents/customer/autonomous";

type Awaiting = Extract<AutonomousOutcome, { status: "awaiting_authorization" }>;

type Phase =
  | { name: "idle" }
  | { name: "running" }
  | { name: "awaiting"; outcome: Awaiting }
  | { name: "stopped"; reason: string; details: string[]; step: string }
  | { name: "paying"; orderNumber: string }
  | { name: "paid"; orderNumber: string }
  | { name: "denied"; reason: string }
  | { name: "failed"; reason: string; checks?: string[] }
  /** Chose the item but not the charge — it goes in the basket instead. */
  | { name: "carted"; option: Awaiting["selected"] };

const STEPS = [
  "Understanding what you asked for",
  "Searching every merchant",
  "Ranking and choosing",
  "Signing the mandate chain",
];

type ChatTurn = { role: "shopper" | "agent"; content: string };

export function AutonomousFlow({
  onExit,
  savedMethod,
}: {
  onExit: () => void;
  /** Description of the stored test method, or null to use the widget. */
  savedMethod: string | null;
}) {
  const router = useRouter();
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
  /** A feature the shopper asked the agent to prioritise when choosing. */
  const [focusQuality, setFocusQuality] = useState<string | null>(null);
  /** Which question the agent last asked, so its answer is routed correctly. */
  const pendingQuestion = useRef<string | null>(null);
  /**
   * Whether the shopper has had their turn to add anything the questions did
   * not cover. Asked once, and only once the agent is otherwise ready.
   */
  const askedExtras = useRef(false);
  /** The last thing actually searched for, so a focus answer can re-use it. */
  const lastQuery = useRef<string>("");
  const [degraded, setDegraded] = useState(false);

  // Loaded up front: by the time the shopper clicks Allow, the widget must be
  // ready — fetching it then would stall the one moment that matters.
  useEffect(() => {
    void loadRazorpayWidget();
  }, []);

  /**
   * One conversational turn before the agent commits to anything.
   *
   * Reuses the assisted shopping endpoint purely to UNDERSTAND — it never buys.
   * When the agent has heard enough, the phrase it synthesised from the whole
   * conversation becomes the single instruction the autonomous run acts on, so
   * what it buys is what was actually discussed.
   */
  const run = useCallback(async (message: string, focus: string | null) => {
    if (!message.trim()) return;
    setPhase({ name: "running" });
    try {
      const response = await fetch("/api/agent/autonomous", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The chosen feature travels with the instruction. It used to be
        // dropped here, so answering the prioritise question changed nothing.
        body: JSON.stringify({ message, focusQuality: focus }),
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
  }, []);

  const send = useCallback(
    async function send(
      text: string,
      opts: { skipQuestions?: boolean; focus?: string | null } = {},
    ) {
      const trimmed = text.trim();
      if (!trimmed && !opts.skipQuestions) return;

      /*
       * A focus answer changes how results are ORDERED, never what is searched.
       *
       * It was being recorded as the focus AND still sent as the message, so
       * "packability" joined the search phrase — "i want shoes, road running,
       * packability" — and the retrieval drifted from shoes to clothing,
       * because shorts and base layers are the things actually rated highly
       * for it. A shopper asking for shoes was shown shorts.
       *
       * So the word never reaches the query: the previous message is re-sent
       * with the focus attached as a ranking input.
       */
      let focus = opts.focus ?? focusQuality;
      const answeringFocus = pendingQuestion.current === "focus" && Boolean(trimmed);
      if (answeringFocus) {
        focus = trimmed;
        setFocusQuality(trimmed);
      }
      pendingQuestion.current = null;

      const query = answeringFocus ? lastQuery.current : trimmed;

      if (!answeringFocus && trimmed) lastQuery.current = trimmed;
      if (trimmed) setMessages((m) => m.concat({ role: "shopper", content: trimmed }));
      setChips([]);
      setChatting(true);

      try {
        const response = await fetch("/api/agent/shop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: query,
            answered,
            history,
            skipQuestions: opts.skipQuestions ?? false,
            focusQuality: focus,
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          setPhase({ name: "failed", reason: data.error ?? "The agent could not understand that." });
          return;
        }

        const dto = data as TurnDto;
        setDegraded(Boolean(dto.provenance?.degraded));
        const nextHistory: ChatTurn[] = answeringFocus
          ? history
          : [...history, { role: "shopper" as const, content: trimmed }];

        if (dto.outcome === "asking" && dto.question) {
          // Remember which question this is, so the NEXT reply can be routed
          // to the ranking rather than into the search text.
          pendingQuestion.current = dto.question.id;
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

        /*
         * The exact request cannot be filled, but we sell something close.
         * Say so and offer it, rather than ending the conversation — that is
         * the whole point of an agent whose job is to sell.
         */
        if (dto.outcome === "alternatives" && dto.alternatives.length > 0) {
          const lines = dto.alternatives
            .map((a) => `• ${a.option.title} — ${a.differences.join("; ")}`)
            .join("\n");
          setMessages((m) =>
            m.concat({
              role: "agent",
              content: `${dto.message}\n\n${lines}\n\nWant me to go ahead with one of these, or shall we change something?`,
            }),
          );
          setChips(
            dto.alternatives.slice(0, 3).map((a) => ({
              label: a.option.title,
              value: `buy the ${a.option.title}`,
            })),
          );
          setHistory([...nextHistory, { role: "agent", content: dto.message ?? "" }]);
          return;
        }

        /*
         * Before spending anything: one open question.
         *
         * The scripted questions cover purpose, size, colour and budget, which
         * is what MOST shoppers need — but not the shopper who cares about a
         * material, a weight limit, a brand to avoid, or anything else nobody
         * thought to put in a slot. Enumerating those is the §8.21 trap; asking
         * plainly is not.
         *
         * The answer goes back through the SAME understanding call as every
         * other turn, so it is interpreted rather than pattern-matched, and it
         * reaches retrieval the way everything else does — through the
         * synthesised phrase and the quality constraints the model extracts
         * from it. Nothing here parses the sentence itself.
         */
        if (!askedExtras.current) {
          askedExtras.current = true;
          pendingQuestion.current = null;
          setHistory(nextHistory);
          setMessages((m) =>
            m.concat({
              role: "agent",
              content:
                "Before I go looking — anything else I should factor in? A material, a feature, a brand, a weight limit, something to avoid. Or say \u201cnothing else\u201d and I will get on with it.",
              note: "Whatever you say here changes what I search for, not just how I rank it.",
            }),
          );
          setChips([
            { label: "Nothing else", value: "nothing else" },
            { label: "Must be waterproof", value: "it must be waterproof" },
            { label: "Lightweight", value: "it should be as lightweight as possible" },
            { label: "Hard-wearing", value: "it needs to be hard-wearing" },
          ]);
          return;
        }

        // Understood enough — hand the synthesised instruction to the buyer.
        setHistory(nextHistory);
        /*
         * The same rule as the server's fallback: the instruction is the
         * REQUEST, not every answer joined together.
         *
         * Joining them turned "looking for some formal shoes" plus the answers
         * "9", "black" and "no budget limit" into a single search phrase in
         * which "formal" was one term among many.
         */
        const beforeFirstQuestion = nextHistory.slice(
          0,
          nextHistory.findIndex((t) => t.role === "agent") === -1
            ? nextHistory.length
            : nextHistory.findIndex((t) => t.role === "agent"),
        );
        const instruction =
          dto.intent?.productQuery ||
          beforeFirstQuestion
            .filter((t) => t.role === "shopper")
            .map((t) => t.content)
            .join(", ") ||
          nextHistory.find((t) => t.role === "shopper")?.content ||
          trimmed;
        setMessages((m) =>
          m.concat({
            role: "agent",
            content: `Right — looking for ${instruction}. Let me find the best option and prepare the order.`,
          }),
        );
        await run(instruction, focus);
      } catch {
        setPhase({ name: "failed", reason: "Could not reach the agent." });
      } finally {
        setChatting(false);
      }
    },
    [answered, history, focusQuality, run],
  );

  const resetConversation = useCallback(() => {
    setMessages([]);
    setHistory([]);
    setAnswered([]);
    setChips([]);
    // A fresh conversation gets the open question again — it was answered
    // about a different shopping trip.
    askedExtras.current = false;
    pendingQuestion.current = null;
    setFocusQuality(null);
    setPhase({ name: "idle" });
  }, []);


  /**
   * Take the agent's choice, but not the charge.
   *
   * Rejects the pending authorization FIRST. The agent has already reserved
   * stock for its checkout session, so adding to the basket without releasing
   * that would hold the same units twice — and the shopper would be blocked
   * from buying the thing they just put in their cart.
   */
  async function addChoiceToCart(outcome: Awaiting) {
    setPhase({ name: "running" });
    try {
      await fetch("/api/commerce/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId: outcome.approvalId, decision: "reject" }),
      });

      const form = new FormData();
      form.set("variantId", outcome.selected.variantId);
      form.set("quantity", "1");
      const result = await addToCartAction(null, form);

      if (result?.error) {
        setPhase({ name: "failed", reason: result.error });
        return;
      }
      setPhase({ name: "carted", option: outcome.selected });
    } catch {
      setPhase({ name: "failed", reason: "Could not add that to your cart." });
    }
  }

  /**
   * Rejects the pick and carries the objection back into the conversation.
   *
   * The agent choosing is a proposal, not a conclusion. Denying used to end the
   * run and lose everything already established — the purpose, size, colour and
   * budget the shopper had just spent four questions answering. Their objection
   * becomes the next thing they said, so the agent narrows rather than restarts.
   */
  async function keepLooking(outcome: Awaiting, note: string) {
    setPhase({ name: "running" });

    // Release the stock the agent was holding before searching again.
    await fetch("/api/commerce/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId: outcome.approvalId, decision: "reject" }),
    }).catch(() => undefined);

    setMessages((m) =>
      m.concat(
        { role: "agent", content: `I picked ${outcome.selected.title}.` },
        { role: "shopper", content: note },
      ),
    );
    setPhase({ name: "idle" });
    await send(note);
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
        return (router.refresh(), setPhase({ name: "paid", orderNumber: saved.orderNumber }));
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

    // Two different situations, and they were sharing one message: the mock
    // gateway is a configuration choice, a widget that will not load is a
    // problem the shopper can act on. Telling them apart is the whole point.
    if (result.gateway === "mock") {
      return setPhase({
        name: "failed",
        reason: "Mock gateway is enabled; set PAYMENT_GATEWAY=razorpay to pay. Nothing was charged.",
      });
    }

    const Razorpay = await loadRazorpayWidget();
    if (!Razorpay) return setPhase({ name: "failed", reason: WIDGET_UNAVAILABLE });

    const checkout = new Razorpay({
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
            ? ((router.refresh()), { name: "paid", orderNumber: confirmed.orderNumber })
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
          onAddToCart={() => addChoiceToCart(phase.outcome)}
          onKeepLooking={(note) => keepLooking(phase.outcome, note)}
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
      {phase.name === "carted" ? (
        <div className="animate-fade-up space-y-4">
          <Alert tone="success" title="Added to your cart">
            <p>
              {phase.option.title} is in your basket. Nothing has been charged, and the stock the
              agent was holding has been released.
            </p>
          </Alert>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => router.push("/checkout")}>Proceed to checkout</Button>
            <Button variant="secondary" onClick={() => router.push("/cart")}>
              View cart
            </Button>
            <Button variant="ghost" onClick={resetConversation}>
              Keep shopping
            </Button>
          </div>

          {/* What people who bought this also bought. */}
          <AlsoLike productId={phase.option.productId} title={phase.option.title} />
        </div>
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
function NotRight({ onKeepLooking }: { onKeepLooking: (note: string) => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");

  const quick = [
    "Too expensive",
    "Show me something lighter",
    "I want a different colour",
    "Different brand please",
  ];

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-primary underline underline-offset-4 hover:text-primary/80"
      >
        Not what I wanted — keep looking
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">
        Tell me what is wrong with it and I will carry on from here.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {quick.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onKeepLooking(q)}
            className="rounded-full border border-border px-2.5 py-1 text-xs transition-colors hover:border-primary hover:text-primary"
          >
            {q}
          </button>
        ))}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (note.trim()) onKeepLooking(note.trim());
        }}
      >
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. I wanted something under 3000"
          aria-label="What was wrong with this pick?"
          className="h-9 w-full rounded-lg border border-input bg-card px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        />
        <Button size="sm" type="submit" disabled={!note.trim()}>
          Send
        </Button>
      </form>
    </div>
  );
}

function AuthorizationScreen({
  outcome,
  onApprove,
  onDeny,
  onAddToCart,
  onKeepLooking,
  savedMethod,
}: {
  outcome: Awaiting;
  onApprove: () => void;
  onDeny: () => void;
  /** Take the choice without the charge. */
  onAddToCart: () => void;
  /** Reject the pick but stay in the conversation. */
  onKeepLooking: (note: string) => void;
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
              <Link
                href={`/product/${selected.productId}`}
                className="text-sm font-semibold hover:text-primary hover:underline"
              >
                {selected.title}
              </Link>
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

          {/*
            * Three outcomes, not two.
            *
            * The agent has chosen; that does not mean the shopper must buy now.
            * Adding to the basket keeps the decision without the charge, and is
            * the honest default for someone who wants to keep looking.
            */}
          <div className="flex flex-wrap gap-2">
            <Button size="lg" onClick={onApprove} className="flex-1">
              <Check className="size-4" />
              Allow — pay {formatMoney(totals.totalMinor, totals.currency)}
            </Button>
            <Button size="lg" variant="secondary" onClick={onAddToCart}>
              <ShoppingCart className="size-4" />
              Add to cart instead
            </Button>
            <Button size="lg" variant="ghost" onClick={onDeny}>
              <X className="size-4" />
              Deny
            </Button>
          </div>
          <p className="text-xs text-subtle">
            Adding to the cart charges nothing and releases the stock the agent was holding.
          </p>

          {/*
            * Not happy with the pick? Say why.
            *
            * The agent choosing is not the end of the conversation — it is a
            * proposal. Rejecting used to be a dead end that lost everything
            * already established, so the objection is carried back into the
            * chat as the next thing the shopper said.
            */}
          <NotRight onKeepLooking={onKeepLooking} />

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

            {/*
              * Buyers, in their own words, on the screen where money is
              * authorised.
              *
              * Kept visually apart from the reasons above because it is a
              * different kind of claim. Everything above is the agent
              * explaining itself; this is people who bought the thing, quoted
              * exactly, with no model between them and the reader.
              */}
            {outcome.evidence.length > 0 ? (
              <div className="mt-4 border-t border-border pt-3">
                <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  What buyers said
                </p>
                <div className="space-y-2">
                  {outcome.evidence.map((quote, index) => (
                    <blockquote key={index} className="border-l-2 border-border pl-3">
                      <p className="text-sm leading-relaxed">&ldquo;{quote.body}&rdquo;</p>
                      {quote.ratingBp ? (
                        <div className="mt-1">
                          <StarDisplay stars={quote.ratingBp / 1000} />
                        </div>
                      ) : null}
                    </blockquote>
                  ))}
                </div>
              </div>
            ) : null}
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
                {/* A runner-up is a real product the shopper may prefer once
                    they read it, so it links through like any other. */}
                <Link
                  href={`/product/${alt.option.productId}`}
                  className="text-sm font-medium hover:text-primary hover:underline"
                >
                  {alt.option.title}
                </Link>
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
