"use client";

import { useState, useTransition } from "react";
import { RotateCcw } from "lucide-react";
import { Alert, Button, Input } from "@/components/ui";
import { requestRefundAction } from "@/server/commerce/refund-actions";

/**
 * Asking for a refund, from the shopper's side.
 *
 * Shown only when the seller's own returns window is still open, with the days
 * remaining stated — a button that appears and then refuses is worse than no
 * button, because the shopper has already decided by the time they are told no.
 *
 * A reason is asked for but not required. Requiring one turns a refund into a
 * negotiation, and the policy the merchant published does not have a
 * justification clause in it.
 */
export function RefundRequest({
  orderId,
  daysLeft,
}: {
  orderId: string;
  daysLeft: number;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<{ ok?: string; error?: string } | null>(null);
  const [pending, startTransition] = useTransition();

  if (result?.ok) {
    return <Alert tone="success">{result.ok}</Alert>;
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          <RotateCcw className="size-3.5" />
          Return this order
        </Button>
        <span className="text-xs text-subtle">
          {daysLeft === 0
            ? "Last day of the returns window"
            : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left to return this`}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <p className="text-sm">
        The full amount goes back the way you paid. Tell them why, if you like.
      </p>
      {result?.error ? <Alert tone="danger">{result.error}</Alert> : null}
      <div className="flex flex-wrap gap-2">
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Optional — didn't fit, arrived damaged…"
          aria-label="Why are you returning this?"
          className="h-9 min-w-56 flex-1"
        />
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const outcome = await requestRefundAction(orderId, reason.trim() || undefined);
              setResult("error" in outcome ? { error: outcome.error } : { ok: outcome.message });
            })
          }
        >
          {pending ? "Refunding…" : "Confirm return"}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
