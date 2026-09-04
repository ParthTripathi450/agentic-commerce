"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, ShieldCheck, User, X } from "lucide-react";
import { Alert, Badge, Button, Card, CardBody } from "@/components/ui";
import { AddressPicker, type PickableAddress } from "./address-picker";
import { formatMoney } from "@/lib/money";

/**
 * One checkout across every merchant in the cart.
 *
 * The shopper approves once and pays once; behind it each merchant still gets
 * their own order and their own signed Cart Mandate. The breakdown below is
 * shown in full rather than collapsed to a single number, because the shopper
 * is paying each merchant's shipping separately and should see that.
 */

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

type Totals = {
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  currency: string;
};

type Line = {
  merchantName: string;
  merchantSlug: string;
  proposal: {
    approvalId: string;
    totals: Totals;
    cart: { lines: { title: string; quantity: number }[] };
  };
};

type Proposal = {
  status: "requires_authorization";
  groupId: string;
  totals: Totals;
  lines: Line[];
  limitsSummary: string[];
  /** Baskets NOT in this payment, with the reason. Never hidden. */
  excluded: { merchantName: string; reason: string }[];
};

type Step = { label: string; detail: string; status: "ok" | "failed" };

type Phase =
  | { name: "preparing" }
  | { name: "blocked"; reason: string; issues: string[] }
  | { name: "review"; proposal: Proposal }
  | { name: "choosing"; proposal: Proposal }
  | { name: "agent"; proposal: Proposal; steps: Step[]; done: boolean }
  | { name: "working"; note: string }
  | { name: "paid"; orderNumbers: string[]; steps: Step[] }
  | { name: "failed"; reason: string; steps?: Step[] };

export function GroupCheckoutFlow({
  savedMethod,
  addresses,
}: {
  savedMethod: string | null;
  addresses: PickableAddress[];
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ name: "preparing" });
  /*
   * One address for the whole group.
   *
   * Every order here ships to the same doorstep — that is what makes it one
   * delivery decision even though it is several merchants — so it is chosen
   * once, pre-set to their usual, rather than asked per merchant.
   */
  const [addressId, setAddressId] = useState<string | null>(
    addresses.find((a) => a.isDefault)?.id ?? addresses[0]?.id ?? null,
  );

  const prepare = useCallback(async () => {
    setPhase({ name: "preparing" });
    const result = await (
      await fetch("/api/commerce/group/checkout", { method: "POST" })
    ).json();
    if (result.status !== "requires_authorization") {
      setPhase({
        name: "blocked",
        reason: result.reason ?? "Checkout is not available right now.",
        issues: result.issues ?? [],
      });
      return;
    }
    setPhase({ name: "review", proposal: result as Proposal });
  }, []);

  useEffect(() => {
    void prepare();
  }, [prepare]);

  /** Authorises every basket, then hands back the single gateway order. */
  async function authorize(proposal: Proposal) {
    return (
      await fetch("/api/commerce/group/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupId: proposal.groupId,
          approvalIds: proposal.lines.map((l) => l.proposal.approvalId),
          decision: "approve",
          addressId,
        }),
      })
    ).json();
  }

  async function payManually(proposal: Proposal) {
    setPhase({ name: "working", note: "Authorising each merchant's basket…" });
    const authorized = await authorize(proposal);
    if (authorized.status !== "authorized") {
      return setPhase({ name: "failed", reason: authorized.reason ?? "Authorization failed." });
    }
    if (!window.Razorpay) {
      return setPhase({
        name: "failed",
        reason: "Payment widget unavailable. Nothing was charged.",
      });
    }

    // The genuine Razorpay window — the shopper enters the card themselves.
    const checkout = new window.Razorpay({
      key: authorized.gatewayKeyId,
      order_id: authorized.gatewayOrderId,
      amount: authorized.amountMinor,
      currency: authorized.currency,
      name: `${proposal.lines.length} merchant${proposal.lines.length === 1 ? "" : "s"}`,
      description: proposal.lines.map((l) => l.merchantName).join(", "),
      handler: async (rp: Record<string, string>) => {
        setPhase({ name: "working", note: "Verifying the signature…" });
        const confirmed = await (
          await fetch("/api/commerce/group/confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              groupId: proposal.groupId,
              gatewayPaymentId: rp.razorpay_payment_id,
              signature: rp.razorpay_signature,
            }),
          })
        ).json();
        if (confirmed.status === "paid") {
          // The sidebar cart badge is server-rendered, so a paid cart keeps
          // showing its old count until the layout re-renders.
          router.refresh();
          setPhase({ name: "paid", orderNumbers: confirmed.orderNumbers, steps: [] });
        } else {
          setPhase({ name: "failed", reason: confirmed.reason });
        }
      },
      modal: {
        ondismiss: () =>
          setPhase({
            name: "failed",
            reason: "Payment window closed. You have not been charged.",
          }),
      },
      theme: { color: "#7f56d9" },
    });
    checkout.open();
  }

  async function payAsAgent(proposal: Proposal) {
    setPhase({ name: "agent", proposal, steps: [], done: false });

    const authorized = await authorize(proposal);
    if (authorized.status !== "authorized") {
      return setPhase({ name: "failed", reason: authorized.reason ?? "Authorization failed." });
    }
    setPhase({
      name: "agent",
      proposal,
      steps: [
        {
          label: `Authorised ${proposal.lines.length} basket${proposal.lines.length === 1 ? "" : "s"}`,
          detail: `Each merchant's Cart Mandate verified · one charge of ${formatMoney(authorized.amountMinor, authorized.currency)}`,
          status: "ok",
        },
      ],
      done: false,
    });

    const result = await (
      await fetch("/api/commerce/group/pay-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId: proposal.groupId }),
      })
    ).json();

    const steps: Step[] = [
      {
        label: `Authorised ${proposal.lines.length} basket${proposal.lines.length === 1 ? "" : "s"}`,
        detail: `Each merchant's Cart Mandate verified · one charge of ${formatMoney(authorized.amountMinor, authorized.currency)}`,
        status: "ok",
      },
      ...(result.steps ?? []),
    ];

    if (result.status === "paid") router.refresh();
    setPhase(
      result.status === "paid"
        ? { name: "paid", orderNumbers: result.orderNumbers, steps }
        : { name: "failed", reason: result.reason ?? "The agent could not complete the payment.", steps },
    );
  }

  // ------------------------------------------------------------ rendering

  if (phase.name === "preparing" || phase.name === "working") {
    return (
      <Card data-static="true">
        <CardBody className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {phase.name === "preparing" ? "Checking stock, prices and your limits…" : phase.note}
        </CardBody>
      </Card>
    );
  }

  if (phase.name === "blocked") {
    return (
      <Alert tone="warning" title="Cannot check out yet">
        <p>{phase.reason}</p>
        {phase.issues.length > 0 ? (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            {phase.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        ) : null}
      </Alert>
    );
  }

  if (phase.name === "paid") {
    return (
      <div className="space-y-4">
        <Alert tone="success" title="Paid">
          {phase.orderNumbers.length === 1
            ? `Order ${phase.orderNumbers[0]} is confirmed.`
            : `${phase.orderNumbers.length} orders confirmed: ${phase.orderNumbers.join(", ")}. Each merchant fulfils and ships separately.`}
        </Alert>
        {phase.steps.length > 0 ? <StepList steps={phase.steps} /> : null}
        <Button onClick={() => router.push("/orders")}>View orders</Button>
      </div>
    );
  }

  if (phase.name === "failed") {
    return (
      <div className="space-y-4">
        <Alert tone="danger" title="Not charged">
          {phase.reason}
        </Alert>
        {phase.steps?.length ? <StepList steps={phase.steps} /> : null}
        <Button variant="secondary" onClick={() => void prepare()}>
          Try again
        </Button>
      </div>
    );
  }

  if (phase.name === "agent") {
    return (
      <div className="space-y-4">
        <Card>
          <CardBody className="space-y-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-agent-cta" aria-hidden />
              <p className="text-sm font-medium">The agent is paying. Every step is shown as it happens.</p>
            </div>
            <StepList steps={phase.steps} pending />
          </CardBody>
        </Card>
      </div>
    );
  }

  const proposal = phase.proposal;
  const multi = proposal.lines.length > 1;

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium">
              {multi
                ? `${proposal.lines.length} merchants, one payment`
                : proposal.lines[0].merchantName}
            </p>
            <p className="text-xl font-semibold tabular">
              {formatMoney(proposal.totals.totalMinor, proposal.totals.currency)}
            </p>
          </div>

          <ul className="divide-y divide-border rounded-lg border border-border">
            {proposal.lines.map((line) => (
              <li key={line.proposal.approvalId} className="flex items-start justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{line.merchantName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {line.proposal.cart.lines
                      .map((l) => `${l.quantity}× ${l.title}`)
                      .join(", ")}
                  </p>
                </div>
                <span className="tabular shrink-0 text-sm">
                  {formatMoney(line.proposal.totals.totalMinor, line.proposal.totals.currency)}
                </span>
              </li>
            ))}
          </ul>

          <AddressPicker addresses={addresses} selectedId={addressId} onSelect={setAddressId} />

          {multi ? (
            <p className="text-xs text-muted-foreground">
              Each merchant ships and fulfils separately, so each one&rsquo;s delivery charge is
              included above. You are charged once.
            </p>
          ) : null}

          {proposal.excluded?.length ? (
            <Alert tone="warning" title="Not included in this payment">
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {proposal.excluded.map((e) => (
                  <li key={e.merchantName}>
                    <strong>{e.merchantName}</strong> — {e.reason}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs">
                These stay in your cart. The total above does not cover them.
              </p>
            </Alert>
          ) : null}

          {proposal.limitsSummary.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {proposal.limitsSummary.slice(0, 4).map((l) => (
                <Badge key={l} tone="neutral">
                  {l}
                </Badge>
              ))}
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <p className="text-sm font-medium">How would you like to pay?</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => void payManually(proposal)}
              className="rounded-lg border-2 border-border p-4 text-left transition-colors hover:border-primary"
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <User className="size-4" aria-hidden />
                I&rsquo;ll pay myself
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                Opens the Razorpay window. You enter the card details.
              </span>
            </button>

            <button
              type="button"
              onClick={() => void payAsAgent(proposal)}
              className="rounded-lg border-2 border-agent-cta/40 p-4 text-left transition-colors hover:border-agent-cta"
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="size-4 text-agent-cta" aria-hidden />
                Let the agent pay
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {savedMethod
                  ? `Uses ${savedMethod}. You watch each step as it happens.`
                  : "Settles server-side. You watch each step as it happens."}
              </span>
            </button>
          </div>
          <p className="text-xs text-subtle">
            Nothing is charged until you choose. The agent cannot pay without this consent.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}

/** Real steps, appended only after the work they describe succeeded. */
function StepList({ steps, pending = false }: { steps: Step[]; pending?: boolean }) {
  return (
    <ol className="space-y-2">
      {steps.map((step, i) => (
        <li key={`${step.label}-${i}`} className="flex items-start gap-2.5 text-sm">
          <span
            className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full ${
              step.status === "ok" ? "bg-success-soft text-success" : "bg-danger-soft text-danger"
            }`}
          >
            {step.status === "ok" ? (
              <Check className="size-3" aria-hidden />
            ) : (
              <X className="size-3" aria-hidden />
            )}
          </span>
          <span className="min-w-0">
            <span className="font-medium">{step.label}</span>
            <span className="block text-xs text-muted-foreground">{step.detail}</span>
          </span>
        </li>
      ))}
      {pending ? (
        <li className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Working…
        </li>
      ) : null}
    </ol>
  );
}
