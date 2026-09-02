"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { cancelOrderAction, fulfilOrderAction } from "@/server/merchant/order-actions";

export function OrderActions({ orderId, state }: { orderId: string; state: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: true; message: string } | { error: string }>) =>
    startTransition(async () => {
      setMessage(null);
      setError(null);
      const result = await fn();
      if ("error" in result) setError(result.error);
      else {
        setMessage(result.message);
        router.refresh();
      }
    });

  const canFulfil = state === "paid";
  const canCancel = state === "paid" || state === "pending_payment";

  if (!canFulfil && !canCancel) {
    return <span className="text-xs text-subtle">—</span>;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-1">
        {canFulfil ? (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => fulfilOrderAction(orderId))}>
            {pending ? "…" : "Mark delivered"}
          </Button>
        ) : null}
        {canCancel ? (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => cancelOrderAction(orderId))}>
            Cancel
          </Button>
        ) : null}
      </div>
      {message ? <span className="text-xs text-success">{message}</span> : null}
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </div>
  );
}
