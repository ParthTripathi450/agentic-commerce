"use client";

import { useActionState, useState } from "react";
import { Alert, Badge, Button, Textarea } from "@/components/ui";
import { submitMerchantReviewAction } from "@/server/reviews/actions";
import { StarDisplay, StarRating } from "./star-rating";

type State = { ok?: boolean; message?: string; error?: string } | null;

/**
 * Rates how the merchant handled an order.
 *
 * Kept separate from the per-item rating because it measures a different thing:
 * dispatch speed, packaging and communication rather than the product itself.
 */
export function MerchantReviewControl({
  orderId,
  merchantName,
  existingStars,
  existingComment,
}: {
  orderId: string;
  merchantName: string;
  existingStars: number | null;
  existingComment: string | null;
}) {
  const [state, action, pending] = useActionState<State, FormData>(
    submitMerchantReviewAction,
    null,
  );
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Merchant service:</span>
        {existingStars ? (
          <>
            <StarDisplay stars={existingStars} />
            <Badge tone="success">rated</Badge>
          </>
        ) : (
          <span className="text-xs text-subtle">not rated</span>
        )}
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          {existingStars ? "Edit" : `Rate ${merchantName}`}
        </Button>
        {state?.ok ? <span className="text-xs text-success">{state.message}</span> : null}
      </div>
    );
  }

  return (
    <form action={action} className="mt-2 space-y-3 rounded-lg border border-border bg-surface-2 p-3">
      <input type="hidden" name="orderId" value={orderId} />

      <p className="text-xs text-muted-foreground">
        How did <span className="font-medium text-foreground">{merchantName}</span> handle this
        order? This rates their service — dispatch, packaging, communication — not the product.
      </p>

      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state?.ok ? <Alert tone="success">{state.message}</Alert> : null}

      <StarRating name="stars" defaultValue={existingStars} />

      <Textarea
        name="comment"
        rows={2}
        placeholder="Anything the merchant should know? (optional)"
        defaultValue={existingComment ?? ""}
        maxLength={1000}
      />

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : existingStars ? "Update rating" : "Rate merchant"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
