"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Image from "next/image";
import { ChevronDown, ShieldCheck, ShoppingCart, Sparkles } from "lucide-react";
import { Alert, Badge, Button, Card, CardBody, Input } from "@/components/ui";
import { StarDisplay } from "@/components/reviews/star-rating";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { OptionDto, TurnDto } from "@/server/agents/customer/dto";
import { PurchaseFlow } from "./purchase-flow";
import { QuantityStepper } from "@/components/cart/quantity-stepper";
import { addToCartAction } from "@/server/commerce/cart-actions";
import { AutonomousFlow } from "./autonomous-flow";
import { ClarifyPanel, ConversationTrail } from "./clarify-panel";
// The same pure helper the agent uses server-side, so chips and free text are
// folded into the message identically on both sides.
import { applyAnswer, type SlotId } from "@/server/agents/customer/clarify";
import { FeaturedGrid } from "./featured-grid";
import type { FeaturedProduct } from "@/server/catalog/featured";

const EXAMPLES = [
  "Find me black running shoes, size 10, under ₹5,000",
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
  const [query, setQuery] = useState(initialQuery ?? "");
  const [turn, setTurn] = useState<TurnDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /**
   * The conversation so far.
   *
   * `message` accumulates the shopper's answers as natural language, so every
   * turn is re-parsed by the SAME intent parser — there is no second path that
   * turns chips straight into filters and drifts from it.
   */
  const [message, setMessage] = useState("");
  const [answered, setAnswered] = useState<string[]>([]);
  const [trail, setTrail] = useState<{ question: string; answer: string }[]>([]);

  const run = useCallback(async function run(
    message: string,
    answered: string[] = [],
    skipQuestions = false,
  ) {
    if (!message.trim()) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/agent/shop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, answered, skipQuestions, history: [] }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "The agent could not complete that request.");
        setTurn(null);
      } else {
        setTurn(data as TurnDto);
      }
    } catch {
      setError("Could not reach the shopping agent. Check that the server is running.");
    } finally {
      setPending(false);
    }
  }, []);

  /** A new search clears the previous conversation — answers must not leak across it. */
  const startConversation = useCallback(
    (text: string) => {
      setMessage(text);
      setAnswered([]);
      setTrail([]);
      void run(text, []);
    },
    [run],
  );

  const answerQuestion = useCallback(
    (slotId: string, value: string) => {
      const label = turn?.question?.question ?? "";
      const next = applyAnswer(message, slotId as SlotId, value);
      const nextAnswered = [...answered, slotId];
      setMessage(next);
      setAnswered(nextAnswered);
      setTrail((t) => [...t, { question: label, answer: value }]);
      void run(next, nextAnswered);
    },
    [answered, message, run, turn],
  );

  const skipAllQuestions = useCallback(() => {
    void run(message, answered, true);
  }, [answered, message, run]);

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

          <form
            onSubmit={(event) => {
              event.preventDefault();
              startConversation(query);
            }}
            className="flex gap-2"
          >
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find me black running shoes, size 10, under ₹5,000"
              aria-label="What are you looking for?"
              disabled={pending}
            />
            <Button type="submit" disabled={pending || query.trim().length < 2}>
              {pending ? "Searching…" : "Search"}
            </Button>
          </form>

          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                disabled={pending}
                onClick={() => {
                  setQuery(example);
                  startConversation(example);
                }}
                className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
              >
                {example}
              </button>
            ))}
          </div>

          {degraded ? (
            <p className="text-xs text-subtle">
              No AI provider configured — running on deterministic rules. Ranking and
              explanations still work; the wording is templated.
            </p>
          ) : null}
        </CardBody>
      </Card>

      {error ? <Alert tone="danger" title="Request failed">{error}</Alert> : null}
      {pending ? <AgentProgress /> : null}
      {turn && !pending && turn.outcome === "asking" ? (
        <div className="space-y-3">
          <ConversationTrail entries={trail} />
          <ClarifyPanel
            turn={turn}
            pending={pending}
            onAnswer={answerQuestion}
            onSkipAll={skipAllQuestions}
          />
        </div>
      ) : null}

      {turn && !pending && turn.outcome !== "asking" ? (
        <div className="space-y-3">
          <ConversationTrail entries={trail} />
          <TurnView turn={turn} />
        </div>
      ) : null}

      {!turn && !pending && !error ? (
        <FeaturedGrid
          products={featured}
          onPick={(title) => {
            setQuery(title);
            void run(title);
          }}
        />
      ) : null}
    </div>
  );
}

/** Names the real pipeline stages rather than showing an opaque spinner. */
function AgentProgress() {
  const steps = ["Understanding your request", "Searching merchant catalogs", "Ranking options", "Explaining the choice"];
  return (
    <Card>
      <CardBody className="space-y-2">
        {steps.map((step, index) => (
          <div key={step} className="flex items-center gap-2.5 text-sm text-muted-foreground">
            <span
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary"
              style={{ animationDelay: `${index * 160}ms` }}
            />
            {step}
          </div>
        ))}
      </CardBody>
    </Card>
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
