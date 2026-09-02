"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Image from "next/image";
import { ChevronDown, ShieldCheck, ShoppingCart, Sparkles } from "lucide-react";
import { Alert, Badge, Button, Card, CardBody } from "@/components/ui";
import { StarDisplay } from "@/components/reviews/star-rating";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { OptionDto, TurnDto } from "@/server/agents/customer/dto";
import { PurchaseFlow } from "./purchase-flow";
import { QuantityStepper } from "@/components/cart/quantity-stepper";
import { addToCartAction } from "@/server/commerce/cart-actions";
import { AutonomousFlow } from "./autonomous-flow";
import { ChatPanel, type ChatMessage } from "./chat-panel";
import { FeaturedGrid } from "./featured-grid";
import type { FeaturedProduct } from "@/server/catalog/featured";

const EXAMPLES = [
  "I want shoes",
  "Formal shoes for a wedding, size 9",
  "Football boots for firm ground",
  "The cheapest yoga mat I can return easily",
];

export function ShoppingAgent({
  degraded,
  featured,
  initialQuery,
  savedMethod,
}: {
  degraded: boolean;
  featured: FeaturedProduct[];
  initialQuery?: string;
  savedMethod: string | null;
}) {
  const [autonomous, setAutonomous] = useState(false);
  const [turn, setTurn] = useState<TurnDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /**
   * The conversation.
   *
   * `history` is what the MODEL reads — the full transcript, so a later reply
   * can reinterpret an earlier one ("actually make that wide fit") rather than
   * only appending to it. `messages` is what the shopper sees.
   */
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<{ role: "shopper" | "agent"; content: string }[]>([]);
  const [answered, setAnswered] = useState<string[]>([]);
  const [chips, setChips] = useState<{ label: string; value: string }[]>([]);

  /**
   * One conversational turn.
   *
   * Sends the shopper's words plus the transcript so far. The agent decides
   * whether it understands enough to search or needs to ask again — that
   * judgement lives server-side in `conversation.ts`, not here.
   */
  const send = useCallback(
    async function send(
      text: string,
      opts: { reset?: boolean; skipQuestions?: boolean } = {},
    ) {
      const trimmed = text.trim();
      if (!trimmed && !opts.skipQuestions) return;

      const priorHistory = opts.reset ? [] : history;
      const priorAnswered = opts.reset ? [] : answered;

      if (trimmed) {
        setMessages((m) => (opts.reset ? [] : m).concat({ role: "shopper", content: trimmed }));
      }
      setChips([]);
      setPending(true);
      setError(null);
      if (opts.reset) setTurn(null);

      try {
        const response = await fetch("/api/agent/shop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: trimmed,
            answered: priorAnswered,
            skipQuestions: opts.skipQuestions ?? false,
            history: priorHistory,
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          setError(data.error ?? "The agent could not complete that request.");
          setTurn(null);
          return;
        }

        const dto = data as TurnDto;
        setTurn(dto);

        const nextHistory = [...priorHistory, { role: "shopper" as const, content: trimmed }];

        if (dto.outcome === "asking" && dto.question) {
          setMessages((m) =>
            m.concat({
              role: "agent",
              content: dto.question!.question,
              note: dto.question!.rationale || undefined,
            }),
          );
          setChips(dto.question.options);
          setAnswered([...priorAnswered, dto.question.id]);
          setHistory([...nextHistory, { role: "agent", content: dto.question.question }]);
          return;
        }

        setHistory(nextHistory);
        setAnswered(priorAnswered);
        setMessages((m) =>
          m.concat({
            role: "results",
            content:
              dto.outcome === "results"
                ? dto.narrative || "Here is what I found."
                : dto.message || "I could not find anything matching that.",
          }),
        );
      } catch {
        setError("Could not reach the shopping agent. Check that the server is running.");
      } finally {
        setPending(false);
      }
    },
    [answered, history],
  );

  /** A brand-new search: previous answers must not leak into it. */
  const startConversation = useCallback(
    (text: string) => {
      setMessages([]);
      setHistory([]);
      setAnswered([]);
      setChips([]);
      void send(text, { reset: true });
    },
    [send],
  );

  const skipAllQuestions = useCallback(() => {
    void send("just show me the options", { skipQuestions: true });
  }, [send]);

  // A search handed over from the sidebar runs once on arrival.
  const ranInitial = useRef(false);
  useEffect(() => {
    if (initialQuery && !ranInitial.current) {
      ranInitial.current = true;
      startConversation(initialQuery);
    }
  }, [initialQuery, startConversation]);

  if (autonomous) {
    return <AutonomousFlow onExit={() => setAutonomous(false)} savedMethod={savedMethod} />;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 border-b border-border pb-3">
            <Button
              size="lg"
              onClick={() => setAutonomous(true)}
              className="bg-agent-cta text-white hover:bg-agent-cta-hover"
            >
              <ShieldCheck className="size-4" />
              Let the agent buy it for me
            </Button>
            <p className="text-sm text-muted-foreground">
              Or search below and choose yourself.
            </p>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                disabled={pending}
                onClick={() => startConversation(example)}
                className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
              >
                {example}
              </button>
            ))}
          </div>
        </CardBody>
      </Card>

      {error ? <Alert tone="danger" title="Request failed">{error}</Alert> : null}

      <ChatPanel
        messages={messages}
        chips={chips}
        pending={pending}
        degraded={degraded || Boolean(turn?.provenance?.degraded)}
        placeholder={
          messages.length === 0
            ? "e.g. I want shoes"
            : "Answer, or say anything else — I read the whole conversation"
        }
        onSend={(text) => void send(text)}
        onSkip={skipAllQuestions}
        onReset={() => {
          setMessages([]);
          setHistory([]);
          setAnswered([]);
          setChips([]);
          setTurn(null);
          setError(null);
        }}
      >
        {turn && turn.outcome !== "asking" ? <TurnView turn={turn} /> : null}
      </ChatPanel>

      {messages.length === 0 && !pending && !error ? (
        <FeaturedGrid products={featured} onPick={(title) => startConversation(title)} />
      ) : null}
    </div>
  );
}

function TurnView({ turn }: { turn: TurnDto }) {
  const [buying, setBuying] = useState<{ option: OptionDto; quantity: number } | null>(null);

  if (turn.outcome !== "results") {
    return (
      <Alert tone={turn.outcome === "needs_clarification" ? "info" : "warning"}
        title={turn.outcome === "needs_clarification" ? "Need a little more detail" : "No matches"}>
        {turn.message}
      </Alert>
    );
  }

  return (
    <div className="space-y-5">
      {turn.relaxations.length > 0 ? (
        <Alert tone="warning" title="I had to loosen your constraints">
          <ul className="mt-1 space-y-1">
            {turn.relaxations.map((r) => (
              <li key={r.constraint}>
                <span className="font-medium">{r.constraint}</span>: {r.from} → {r.to} — {r.reason}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {turn.points.length > 0 ? <ReasonsPanel points={turn.points} /> : null}

      {buying ? (
        <PurchaseFlow
          key={buying.option.variantId}
          variantId={buying.option.variantId}
          productTitle={buying.option.title}
          quantity={buying.quantity}
          agentSessionId={turn.sessionId}
          intentText={turn.intent.productQuery}
          onClose={() => setBuying(null)}
        />
      ) : null}

      <div className="space-y-3">
        {turn.options.map((option) => (
          <OptionCard
            key={option.variantId}
            option={option}
            intent={turn.intent}
            selected={buying?.option.variantId === option.variantId}
            onSelect={(quantity) => setBuying({ option, quantity })}
          />
        ))}
      </div>

      {turn.excluded.length > 0 ? (
        <Card>
          <CardBody>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Considered and ruled out
            </p>
            <ul className="space-y-1.5">
              {turn.excluded.map((item, index) => (
                <li key={`${item.label}-${index}`} className="text-sm">
                  <span className="text-foreground">{item.label}</span>
                  <span className="text-muted-foreground"> — {item.reason}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <p className="text-xs text-subtle">
        Searched {turn.stats.merchantsSearched} merchants · {turn.stats.recalled} products recalled ·{" "}
        {turn.stats.accepted} met every constraint · {turn.stats.durationMs}ms ·{" "}
        {turn.provenance.degraded ? "deterministic rules" : `${turn.provenance.provider}/${turn.provenance.model}`}
      </p>
    </div>
  );
}

/**
 * Collapsible reasoning.
 *
 * Closed by default so the results are what you see first; the reasons are one
 * click away when you want to check the agent's work.
 */
function ReasonsPanel({ points }: { points: string[] }) {
  const [open, setOpen] = useState(false);

  return (
    <Card className="animate-fade-up border-primary/40">
      <CardBody className="py-0">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="group flex w-full items-center justify-between gap-3 py-4 text-left"
        >
          <span className="text-sm font-semibold text-primary group-hover:underline">
            Why the agent chose this
          </span>
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-primary transition-transform duration-200",
              open && "rotate-180",
            )}
            strokeWidth={2.5}
          />
        </button>

        {open ? (
          <ul className="animate-fade-up space-y-2 border-t border-border pt-3 pb-4">
            {points.map((point, index) => (
              <li key={index} className="flex gap-2.5 text-sm">
                <span
                  className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
                  aria-hidden
                />
                <span className="leading-relaxed">{point}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}

function OptionCard({
  option,
  intent,
  selected,
  onSelect,
}: {
  option: OptionDto;
  intent: TurnDto["intent"];
  selected: boolean;
  onSelect: (quantity: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [adding, startAdding] = useTransition();
  const [addMessage, setAddMessage] = useState<string | null>(null);
  const router = useRouter();
  const isTop = option.rank === 1;
  const maxContribution = Math.max(...option.criteria.map((c) => c.contribution), 0.0001);

  return (
    <Card
      className={cn(
        "animate-fade-up",
        // Border WIDTH matters: shadcn's Card declares none, so a bare
        // `border-primary` colours a zero-width edge and shows nothing.
        isTop && "border-2 border-best-match ring-2 ring-best-match",
        selected && !isTop && "ring-2 ring-primary/40",
      )}
    >
      {isTop ? (
        <div className="-mt-(--card-spacing) mb-1 flex items-center gap-1.5 bg-best-match px-5 py-1.5 text-xs font-semibold text-[#3a3410]">
          <Sparkles className="size-3.5" strokeWidth={2.5} />
          Best match — the agent&rsquo;s pick
        </div>
      ) : null}
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 gap-3">
            {option.imageUrl ? (
              <Image
                src={option.imageUrl}
                alt=""
                width={76}
                height={76}
                unoptimized
                className="size-19 shrink-0 rounded-lg border border-border object-cover"
              />
            ) : null}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {isTop ? null : <Badge>#{option.rank}</Badge>}
                <span className="text-xs text-muted-foreground">{option.merchant.name}</span>
              </div>
              <h3 className="mt-1.5 text-sm font-semibold">{option.title}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {Object.entries(option.variantAttributes)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(" · ")}
              </p>
              {option.ratingBp ? (
                <div className="mt-1">
                  <StarDisplay stars={option.ratingBp / 1000} count={option.ratingCount} />
                </div>
              ) : null}
            </div>
          </div>

          <div className="text-right">
            <p className="tabular text-base font-semibold">
              {formatMoney(option.priceMinor, option.currency)}
            </p>
            {option.compareAtPriceMinor ? (
              <p className="tabular text-xs text-subtle line-through">
                {formatMoney(option.compareAtPriceMinor, option.currency)}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <Badge tone={option.availableQuantity > 5 ? "success" : "warning"}>
            {option.availableQuantity} in stock
          </Badge>
          <Badge>{option.deliveryDays}-day delivery</Badge>
          <Badge tone={option.returnsAccepted ? "neutral" : "danger"}>
            {option.returnsAccepted ? `${option.returnWindowDays}-day returns` : "No returns"}
          </Badge>
          {intent.priceMaxMinor && option.priceMinor <= intent.priceMaxMinor ? (
            <Badge tone="success">Within budget</Badge>
          ) : null}
        </div>

        <div className="space-y-3 border-t border-border pt-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <QuantityStepper
              size="sm"
              value={quantity}
              max={option.availableQuantity}
              onChange={setQuantity}
            />

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={adding || option.availableQuantity === 0}
                onClick={() =>
                  startAdding(async () => {
                    const form = new FormData();
                    form.set("variantId", option.variantId);
                    form.set("quantity", String(quantity));
                    const result = await addToCartAction(null, form);
                    setAddMessage(result?.error ?? result?.message ?? null);
                    router.refresh();
                  })
                }
              >
                <ShoppingCart className="size-4" />
                {adding ? "Adding…" : "Add to cart"}
              </Button>

              <Button
                size="sm"
                variant={isTop ? "primary" : "ghost"}
                onClick={() => onSelect(quantity)}
                disabled={selected || option.availableQuantity === 0}
              >
                {selected ? "Selected" : "Buy now"}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="text-xs font-medium text-primary hover:underline"
              aria-expanded={open}
            >
              {open ? "Hide" : "Show"} score breakdown ({option.score.toFixed(3)})
            </button>
            {addMessage ? <span className="text-xs text-muted-foreground">{addMessage}</span> : null}
          </div>
        </div>

        {open ? (
          <div className="space-y-1.5 rounded-lg bg-surface-2 p-3">
            <p className="text-xs text-muted-foreground">
              Total score is the sum of weight × normalised value for each criterion.
            </p>
            {option.criteria
              .slice()
              .sort((a, b) => b.contribution - a.contribution)
              .map((criterion) => (
                <div key={criterion.name} className="flex items-center gap-2 text-xs">
                  <span className="w-24 shrink-0 text-muted-foreground">{criterion.name}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${(criterion.contribution / maxContribution) * 100}%` }}
                    />
                  </div>
                  <span className="tabular w-32 shrink-0 text-right text-subtle">
                    {criterion.weight} × {criterion.normalized} = {criterion.contribution.toFixed(3)}
                  </span>
                </div>
              ))}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
