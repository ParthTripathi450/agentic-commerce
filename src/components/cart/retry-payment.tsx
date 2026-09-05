"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CreditCard } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { WIDGET_UNAVAILABLE, loadRazorpayWidget } from "@/lib/razorpay-widget";

/**
 * Finish paying an order whose payment failed.
 *
 * The recovery agent's own message says "you can finish it here" and links to
 * this page, so this control is what makes that sentence true. It is also the
 * only way a failed-payment case can ever be VERIFIED recovered — recovery is
 * read from a captured payment on this order, never from a click or a visit.
 *
 * The widget is resolved before the server is asked for anything, for the same
 * reason as every other payment surface (§8.36): a retry that cannot open a
 * payment window would otherwise leave one more unpayable gateway order behind.
 */
export function RetryPayment({
  orderId,
  orderNumber,
  amountLabel,
}: {
  orderId: string;
  orderNumber: string;
  amountLabel: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function pay() {
    setBusy(true);
    try {
      const Razorpay = await loadRazorpayWidget();
      if (!Razorpay) return void toast.error(WIDGET_UNAVAILABLE);

      const result = await (
        await fetch("/api/commerce/retry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId }),
        })
      ).json();

      if (result.status === "paid") {
        toast.success(`${orderNumber} is already paid.`);
        return void router.refresh();
      }
      if (result.status !== "ready") {
        // Limits and stock are re-checked on a retry, so a refusal here is real
        // information rather than a glitch: it says what changed since.
        return void toast.error(result.reason ?? "This order cannot be paid right now.");
      }

      const checkout = new Razorpay({
        key: result.gatewayKeyId,
        order_id: result.gatewayOrderId,
        amount: result.amountMinor,
        currency: result.currency,
        name: orderNumber,
        description: "Completing a payment that did not go through",
        handler: async (rp: Record<string, string>) => {
          const confirmed = await (
            await fetch("/api/commerce/confirm", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                orderId,
                gatewayPaymentId: rp.razorpay_payment_id,
                signature: rp.razorpay_signature,
              }),
            })
          ).json();
          if (confirmed.status === "paid") toast.success(`Paid — ${confirmed.orderNumber} is confirmed.`);
          else toast.error(confirmed.reason ?? "That payment could not be verified.");
          router.refresh();
        },
        modal: { ondismiss: () => toast("Payment window closed. You have not been charged.") },
        theme: { color: "#7f56d9" },
      });
      checkout.open();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
      <Button size="sm" onClick={pay} disabled={busy}>
        <CreditCard className="size-3.5" />
        {busy ? "Opening…" : `Try paying ${amountLabel} again`}
      </Button>
      <span className="text-xs text-muted-foreground">
        Held at the price you saw. Nothing is charged until you complete the payment.
      </span>
    </div>
  );
}
