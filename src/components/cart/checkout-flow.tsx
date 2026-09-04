"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ShieldCheck, X } from "lucide-react";
import { Alert, Button, Card, CardBody } from "@/components/ui";
import { AddressPicker, type PickableAddress } from "./address-picker";
import { formatMoney } from "@/lib/money";
import type { CartView } from "@/server/commerce/cart";

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

type Proposal = {
  status: "requires_authorization";
  approvalId: string;
  cartMandateId: string;
  intentMandateId: string;
  agentSessionId: string;
  cart: CartView;
  totals: CartView["totals"];
  reason: string;
  limitsSummary: string[];
};

type Phase =
  | { name: "preparing" }
  | { name: "awaiting"; proposal: Proposal }
  | { name: "blocked"; reason: string; issues: string[] }
  | { name: "working" }
  | { name: "paid"; orderNumber: string }
  | { name: "declined"; reason: string }
  | { name: "failed"; reason: string; checks?: string[] };

const RAZORPAY_SRC = "https://checkout.razorpay.com/v1/checkout.js";

/**
 * Checkout for a cart the shopper assembled themselves.
 *
 * Same gate as the autonomous flow: policy check, signed mandate chain, one
 * explicit approval. With a saved method the approval finishes the purchase;
 * without one, the hosted widget collects the test card.
 */
export function CheckoutFlow({
  cartId,
  savedMethod,
  addresses,
}: {
  cartId: string;
  savedMethod: string | null;
  addresses: PickableAddress[];
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ name: "preparing" });
  // Their usual address, pre-selected. Re-picking one used ten times is
  // friction with no information in it.
  const [addressId, setAddressId] = useState<string | null>(
    addresses.find((a) => a.isDefault)?.id ?? addresses[0]?.id ?? null,
  );

  useEffect(() => {
    if (savedMethod) return; // widget not needed
    if (window.Razorpay || document.querySelector(`script[src="${RAZORPAY_SRC}"]`)) return;
    const script = document.createElement("script");
    script.src = RAZORPAY_SRC;
    script.async = true;
    document.body.appendChild(script);
  }, [savedMethod]);

  const prepare = useCallback(async () => {
    setPhase({ name: "preparing" });
    const result = await (
      await fetch("/api/commerce/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cartId }),
      })
    ).json();

    if (result.status === "requires_authorization") setPhase({ name: "awaiting", proposal: result });
    else setPhase({ name: "blocked", reason: result.reason ?? result.error, issues: result.issues ?? [] });
  }, [cartId]);

  useEffect(() => {
    void prepare();
  }, [prepare]);

  async function decide(proposal: Proposal, decision: "approve" | "reject") {
    setPhase({ name: "working" });

    if (decision === "reject") {
      const r = await (
        await fetch("/api/commerce/authorize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approvalId: proposal.approvalId, decision: "reject" }),
        })
      ).json();
      return setPhase({ name: "declined", reason: r.reason ?? "Nothing was charged." });
    }

    if (savedMethod) {
      const saved = await (
        await fetch("/api/commerce/pay-saved", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            approvalId: proposal.approvalId,
            agentSessionId: proposal.agentSessionId,
            addressId,
          }),
        })
      ).json();
      if (saved.status === "paid") return (router.refresh(), setPhase({ name: "paid", orderNumber: saved.orderNumber }));
      if (saved.status === "failed") return setPhase({ name: "failed", reason: saved.reason });
    }

    const authorized = await (
      await fetch("/api/commerce/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalId: proposal.approvalId,
          decision: "approve",
          addressId,
        }),
      })
    ).json();

    if (authorized.status !== "authorized") {
      return setPhase({ name: "failed", reason: authorized.reason, checks: authorized.checks });
    }
    if (!window.Razorpay) {
      return setPhase({ name: "failed", reason: "Payment widget unavailable. Nothing was charged." });
    }

    const checkout = new window.Razorpay({
      key: authorized.gatewayKeyId,
      order_id: authorized.gatewayOrderId,
      amount: authorized.amountMinor,
      currency: authorized.currency,
      name: proposal.cart.merchant.name,
      handler: async (rp: Record<string, string>) => {
        const confirmed = await (
          await fetch("/api/commerce/confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orderId: authorized.orderId,
              gatewayPaymentId: rp.razorpay_payment_id,
              signature: rp.razorpay_signature,
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

  if (phase.name === "preparing" || phase.name === "working") {
    return (
      <Card data-static="true">
        <CardBody>
          <p className="text-sm text-muted-foreground">
            {phase.name === "preparing" ? "Checking stock, prices and your limits…" : "Working…"}
          </p>
        </CardBody>
      </Card>
    );
  }

  if (phase.name === "blocked") {
    return (
      <Alert tone="warning" title="Cannot check out yet">
        {phase.reason}
        {phase.issues.length > 0 ? (
          <ul className="mt-1.5 list-disc pl-4">
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
      <div className="space-y-3">
        <Alert tone="success" title="Paid">
          Order <span className="font-mono">{phase.orderNumber}</span> is confirmed.
        </Alert>
        <Button onClick={() => router.push("/orders")}>View your orders</Button>
      </div>
    );
  }

  if (phase.name === "declined") return <Alert tone="neutral">{phase.reason}</Alert>;

  if (phase.name === "failed") {
    return (
      <div className="space-y-3">
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
        <Button variant="secondary" onClick={() => void prepare()}>
          Try again
        </Button>
      </div>
    );
  }

  const { proposal } = phase;
  return (
    <Card className="border-2 border-primary ring-2 ring-primary">
      <div className="-mt-(--card-spacing) mb-1 flex items-center gap-1.5 bg-primary px-5 py-1.5 text-xs font-semibold text-primary-foreground">
        <ShieldCheck className="size-3.5" strokeWidth={2.5} />
        Authorize this payment
      </div>
      <CardBody className="space-y-4">
        <div>
          <p className="text-xs text-muted-foreground">Paying {proposal.cart.merchant.name}</p>
          <p className="tabular mt-0.5 text-3xl font-semibold">
            {formatMoney(proposal.totals.totalMinor, proposal.totals.currency)}
          </p>
        </div>

        <ul className="space-y-1 text-sm">
          {proposal.cart.lines.map((line) => (
            <li key={line.variantId} className="flex justify-between gap-3">
              <span className="min-w-0 truncate">
                {line.quantity}× {line.title}
              </span>
              <span className="tabular shrink-0">
                {formatMoney(line.currentPriceMinor * line.quantity)}
              </span>
            </li>
          ))}
        </ul>

        <AddressPicker addresses={addresses} selectedId={addressId} onSelect={setAddressId} />

        <div className="rounded-lg border border-border p-3">
          <p className="text-xs font-medium text-muted-foreground">Pays with</p>
          <p className="mt-0.5 text-sm">
            {savedMethod ?? "Razorpay checkout window (you enter the test card)"}
          </p>
          <ul className="mt-2 space-y-0.5 text-xs text-subtle">
            {proposal.limitsSummary.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <p className="mt-1 font-mono text-[11px] text-subtle">
            cart {proposal.cartMandateId.slice(0, 8)} · intent {proposal.intentMandateId.slice(0, 8)}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="lg" className="flex-1" onClick={() => decide(proposal, "approve")}>
            <Check className="size-4" />
            Allow — pay {formatMoney(proposal.totals.totalMinor, proposal.totals.currency)}
          </Button>
          <Button size="lg" variant="secondary" onClick={() => decide(proposal, "reject")}>
            <X className="size-4" />
            Cancel
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
