"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, CardBody } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import type { CartView } from "@/server/commerce/cart";

/**
 * The purchase flow: select → propose → AUTHORIZE → pay → confirm.
 *
 * The authorization step is deliberately heavy on detail. It shows the exact
 * amount, the exact items, and the limits that were applied, because this is
 * the one moment where a human takes responsibility for what the agent found.
 */

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

type Proposal = {
  status: "requires_authorization";
  checkoutSessionId: string;
  approvalId: string;
  cartMandateId: string;
  intentMandateId: string;
  cart: CartView;
  totals: CartView["totals"];
  reason: string;
  limitsSummary: string[];
};

type Blocked = { status: "blocked"; reason: string; issues: string[] };

type Phase =
  | { name: "idle" }
  | { name: "preparing" }
  | { name: "awaiting_authorization"; proposal: Proposal }
  | { name: "blocked"; blocked: Blocked }
  | { name: "authorizing" }
  | { name: "paying"; orderNumber: string }
  | { name: "paid"; orderNumber: string }
  | { name: "declined"; reason: string }
  | { name: "failed"; reason: string; checks?: string[] };

const RAZORPAY_SRC = "https://checkout.razorpay.com/v1/checkout.js";

function useRazorpayScript(enabled: boolean) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    if (window.Razorpay) return setReady(true);
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${RAZORPAY_SRC}"]`);
    const script = existing ?? document.createElement("script");
    script.src = RAZORPAY_SRC;
    script.async = true;
    script.onload = () => setReady(true);
    if (!existing) document.body.appendChild(script);
  }, [enabled]);
  return ready;
}

export function PurchaseFlow({
  variantId,
  productTitle,
  agentSessionId,
  intentText,
  onClose,
}: {
  variantId: string;
  productTitle: string;
  agentSessionId?: string;
  intentText?: string;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const razorpayReady = useRazorpayScript(phase.name === "awaiting_authorization");

  const start = useCallback(async () => {
    setPhase({ name: "preparing" });
    try {
      const cartResponse = await fetch("/api/commerce/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // "replace": selecting an option means buying that option, not adding
        // it to whatever is already sitting in an open cart.
        body: JSON.stringify({ variantId, quantity: 1, agentSessionId, mode: "replace" }),
      });
      const cartData = await cartResponse.json();
      if (!cartResponse.ok) {
        return setPhase({ name: "blocked", blocked: { status: "blocked", reason: cartData.error, issues: [] } });
      }

      const checkoutResponse = await fetch("/api/commerce/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cartId: cartData.cart.cartId, agentSessionId, intentText }),
      });
      const result = await checkoutResponse.json();

      if (result.status === "blocked") return setPhase({ name: "blocked", blocked: result });
      if (result.status !== "requires_authorization") {
        return setPhase({ name: "failed", reason: result.error ?? "Checkout could not start." });
      }
      setPhase({ name: "awaiting_authorization", proposal: result });
    } catch {
      setPhase({ name: "failed", reason: "Could not reach the server." });
    }
  }, [variantId, agentSessionId, intentText]);

  useEffect(() => {
    void start();
  }, [start]);

  async function decide(proposal: Proposal, decision: "approve" | "reject") {
    setPhase({ name: "authorizing" });
    const response = await fetch("/api/commerce/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId: proposal.approvalId, decision, agentSessionId }),
    });
    const result = await response.json();

    if (result.status === "rejected") return setPhase({ name: "declined", reason: result.reason });
    if (result.status !== "authorized") {
      return setPhase({ name: "failed", reason: result.reason, checks: result.checks });
    }

    setPhase({ name: "paying", orderNumber: result.orderNumber });

    // Mock gateway has no widget — confirm through the same server path.
    if (result.gateway === "mock") {
      return setPhase({ name: "failed", reason: "Mock gateway is enabled; set PAYMENT_GATEWAY=razorpay to pay." });
    }

    if (!window.Razorpay) {
      return setPhase({ name: "failed", reason: "The payment widget could not load. Nothing was charged." });
    }

    const checkout = new window.Razorpay({
      key: result.gatewayKeyId,
      order_id: result.gatewayOrderId,
      amount: result.amountMinor,
      currency: result.currency,
      name: proposal.cart.merchant.name,
      description: productTitle,
      notes: { cart_mandate: proposal.cartMandateId },
      handler: async (response: Record<string, string>) => {
        const confirmResponse = await fetch("/api/commerce/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orderId: result.orderId,
            gatewayPaymentId: response.razorpay_payment_id,
            signature: response.razorpay_signature,
            agentSessionId,
          }),
        });
        const confirmed = await confirmResponse.json();
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
      theme: { color: "#4f46e5" },
    });
    checkout.open();
  }

  return (
    <Card className="animate-fade-up border-primary">
      <CardBody className="space-y-4">
        {phase.name === "preparing" || phase.name === "idle" ? (
          <p className="text-sm text-muted-foreground">Preparing a verifiable order…</p>
        ) : null}

        {phase.name === "blocked" ? (
          <>
            <Alert tone="warning" title="The agent stopped before spending anything">
              {phase.blocked.reason}
              {phase.blocked.issues.length > 0 ? (
                <ul className="mt-1.5 list-disc pl-4">
                  {phase.blocked.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              ) : null}
            </Alert>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Back to results
            </Button>
          </>
        ) : null}

        {phase.name === "awaiting_authorization" ? (
          <AuthorizationRequest
            proposal={phase.proposal}
            razorpayReady={razorpayReady}
            onApprove={() => decide(phase.proposal, "approve")}
            onDecline={() => decide(phase.proposal, "reject")}
          />
        ) : null}

        {phase.name === "authorizing" ? (
          <p className="text-sm text-muted-foreground">Verifying the mandate chain…</p>
        ) : null}
        {phase.name === "paying" ? (
          <p className="text-sm text-muted-foreground">
            Order {phase.orderNumber} created. Complete the payment in the Razorpay window.
          </p>
        ) : null}

        {phase.name === "paid" ? (
          <>
            <Alert tone="success" title="Payment complete">
              Order <span className="font-mono">{phase.orderNumber}</span> is confirmed. Stock has
              been committed and the mandate consumed so it cannot authorize another charge.
            </Alert>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Keep shopping
            </Button>
          </>
        ) : null}

        {phase.name === "declined" ? (
          <>
            <Alert tone="info" title="Declined">{phase.reason}</Alert>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Back to results
            </Button>
          </>
        ) : null}

        {phase.name === "failed" ? (
          <>
            <Alert tone="danger" title="Payment not completed">
              {phase.reason}
              {phase.checks?.length ? (
                <ul className="mt-1.5 list-disc pl-4 font-mono text-xs">
                  {phase.checks.map((check) => (
                    <li key={check}>{check}</li>
                  ))}
                </ul>
              ) : null}
            </Alert>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Back to results
            </Button>
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

function AuthorizationRequest({
  proposal,
  razorpayReady,
  onApprove,
  onDecline,
}: {
  proposal: Proposal;
  razorpayReady: boolean;
  onApprove: () => void;
  onDecline: () => void;
}) {
  const { cart, totals } = proposal;
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Authorize this payment</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The agent has prepared this order. It cannot charge you without your approval.
          </p>
        </div>
        <Badge tone="accent">AP2 gated</Badge>
      </div>

      <div className="rounded-lg border border-border bg-surface-2 p-3">
        <p className="text-xs text-muted-foreground">Paying</p>
        <p className="mt-0.5 text-2xl font-semibold tabular">
          {formatMoney(totals.totalMinor, totals.currency)}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">to {cart.merchant.name}</p>
      </div>

      <div className="space-y-1.5">
        {cart.lines.map((line) => (
          <div key={line.variantId} className="flex justify-between gap-3 text-sm">
            <span className="min-w-0">
              {line.quantity}× {line.title}
              <span className="text-muted-foreground">
                {" "}
                ({Object.entries(line.attributes).map(([k, v]) => `${k} ${v}`).join(", ")})
              </span>
            </span>
            <span className="tabular shrink-0">
              {formatMoney(line.currentPriceMinor * line.quantity, totals.currency)}
            </span>
          </div>
        ))}
      </div>

      <dl className="space-y-1 border-t border-border pt-3 text-sm">
        <Row label="Subtotal" value={formatMoney(totals.subtotalMinor, totals.currency)} />
        {totals.discountMinor > 0 ? (
          <Row label="Discount" value={`−${formatMoney(totals.discountMinor, totals.currency)}`} />
        ) : null}
        <Row
          label="Shipping"
          value={totals.shippingMinor === 0 ? "Free" : formatMoney(totals.shippingMinor, totals.currency)}
        />
        <Row label="GST (18%)" value={formatMoney(totals.taxMinor, totals.currency)} />
        <div className="flex justify-between border-t border-border pt-1.5 font-semibold">
          <dt>Total</dt>
          <dd className="tabular">{formatMoney(totals.totalMinor, totals.currency)}</dd>
        </div>
      </dl>

      <div className="rounded-lg border border-border p-3">
        <p className="text-xs font-medium text-muted-foreground">Limits applied</p>
        <ul className="mt-1 space-y-0.5 text-xs text-subtle">
          {proposal.limitsSummary.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
          <li>{proposal.reason}</li>
        </ul>
        <p className="mt-2 font-mono text-[11px] text-subtle">
          cart mandate {proposal.cartMandateId.slice(0, 8)} · intent {proposal.intentMandateId.slice(0, 8)}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={onApprove} disabled={!razorpayReady}>
          {razorpayReady ? `Approve ${formatMoney(totals.totalMinor, totals.currency)}` : "Loading payment…"}
        </Button>
        <Button variant="secondary" onClick={onDecline}>
          Decline
        </Button>
      </div>

      <p className="text-xs text-subtle">
        Razorpay test mode — no real money moves. Use domestic test card
        4100 2800 0000 1007, any future expiry, any CVV.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-muted-foreground">
      <dt>{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}
