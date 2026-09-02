"use client";

import { useActionState, useState } from "react";
import { Alert, Badge, Button, Input, Textarea } from "@/components/ui";
import { submitReviewAction } from "@/server/reviews/actions";
import { StarDisplay, StarRating } from "./star-rating";

type State = { ok?: boolean; message?: string; error?: string } | null;

export function ReviewControl({
  orderId,
  variantId,
  productTitle,
  existingStars,
  existingTitle,
  existingBody,
}: {
  orderId: string;
  variantId: string;
  productTitle: string;
  existingStars: number | null;
  existingTitle: string | null;
  existingBody: string | null;
}) {
  const [state, action, pending] = useActionState<State, FormData>(submitReviewAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {existingStars ? (
          <>
            <StarDisplay stars={existingStars} />
            <Badge tone="success">your review</Badge>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">Not rated yet</span>
        )}
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          {existingStars ? "Edit review" : "Rate this item"}
        </Button>
        {state?.ok ? <span className="text-xs text-success">{state.message}</span> : null}
      </div>
    );
  }

  return (
    <form action={action} className="mt-2 space-y-3 rounded-lg border border-border bg-surface-2 p-3">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="variantId" value={variantId} />

      <p className="text-xs text-muted-foreground">
        Rating <span className="font-medium text-foreground">{productTitle}</span>. Your rating
        feeds the score AI agents use to rank this product, so it genuinely changes what other
        shoppers are shown.
      </p>

      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state?.ok ? <Alert tone="success">{state.message}</Alert> : null}

      <StarRating name="stars" defaultValue={existingStars} />

      <Input name="title" placeholder="Sum it up in a few words (optional)" defaultValue={existingTitle ?? ""} maxLength={160} />
      <Textarea
        name="body"
        rows={3}
        placeholder="What was good or bad about it? (optional)"
        defaultValue={existingBody ?? ""}
        maxLength={2000}
      />

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : existingStars ? "Update review" : "Post review"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
