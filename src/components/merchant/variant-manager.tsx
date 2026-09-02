"use client";

import { useActionState, useState, useTransition } from "react";
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, Field, Input, Textarea } from "@/components/ui";
import {
  addVariantAction,
  deleteVariantAction,
  setAvailabilityWindowAction,
} from "@/server/catalog/actions";

type State = { ok?: boolean; message?: string; error?: string } | null;

export function AddVariantForm({ productId }: { productId: string }) {
  const [state, action, pending] = useActionState<State, FormData>(addVariantAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="px-5 py-3">
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          Add a variant
        </Button>
      </div>
    );
  }

  return (
    <Card className="m-5 mt-3">
      <CardHeader>
        <CardTitle>New variant</CardTitle>
      </CardHeader>
      <CardBody>
        <form action={action} className="space-y-3">
          <input type="hidden" name="productId" value={productId} />
          {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
          {state?.ok ? <Alert tone="success">{state.message}</Alert> : null}

          <Field label="Options" hint="One per line, as key: value">
            <Textarea
              name="variantAttributes"
              rows={2}
              className="font-mono text-xs"
              placeholder={"size: 11\ncolor: black"}
              required
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Price (₹)">
              <Input name="price" type="number" step="0.01" min="1" required />
            </Field>
            <Field label="Stock">
              <Input name="quantity" type="number" min="0" required defaultValue={0} />
            </Field>
          </div>

          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Adding…" : "Add variant"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

export function WithdrawVariantButton({
  variantId,
  productId,
  disabled,
}: {
  variantId: string;
  productId: string;
  disabled: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={disabled || pending}
        title={disabled ? "A product needs at least one variant" : "Withdraw from sale"}
        onClick={() =>
          startTransition(async () => {
            const result = await deleteVariantAction(variantId, productId);
            if (result?.error) setError(result.error);
          })
        }
      >
        {pending ? "…" : "Withdraw"}
      </Button>
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </>
  );
}


/**
 * Sale window for one variant.
 *
 * No window means always purchasable. A window is how a merchant schedules a
 * drop or retires a seasonal line without deleting anything — search enforces it
 * live, so an out-of-window variant simply stops being findable by agents.
 */
export function AvailabilityWindowForm({
  variantId,
  productId,
  startsAt,
  endsAt,
}: {
  variantId: string;
  productId: string;
  startsAt: string | null;
  endsAt: string | null;
}) {
  const [state, action, pending] = useActionState<State, FormData>(
    setAvailabilityWindowAction,
    null,
  );
  const [open, setOpen] = useState(false);
  const hasWindow = Boolean(startsAt || endsAt);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-primary hover:underline"
      >
        {hasWindow ? "Edit sale window" : "Set sale window"}
      </button>
    );
  }

  return (
    <form action={action} className="mt-1 w-full space-y-2 rounded-lg bg-surface-2 p-3">
      <input type="hidden" name="variantId" value={variantId} />
      <input type="hidden" name="productId" value={productId} />

      <p className="text-xs text-muted-foreground">
        Leave both blank to make this variant always available.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">On sale from</span>
          <Input name="startsAt" type="datetime-local" defaultValue={startsAt ?? ""} className="h-8 text-xs" />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Until</span>
          <Input name="endsAt" type="datetime-local" defaultValue={endsAt ?? ""} className="h-8 text-xs" />
        </label>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save window"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>

      {state?.error ? <p className="text-xs text-danger">{state.error}</p> : null}
      {state?.ok ? <p className="text-xs text-success">{state.message}</p> : null}
    </form>
  );
}
