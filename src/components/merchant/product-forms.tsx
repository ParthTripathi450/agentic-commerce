"use client";

import { useActionState } from "react";
import { Alert, Badge, Button, Card, CardBody, Field, Input, Select, Textarea } from "@/components/ui";
import { toMajor } from "@/lib/money";
import { updateProductAction, updateVariantAction } from "@/server/catalog/actions";
import { AvailabilityWindowForm, WithdrawVariantButton } from "./variant-manager";

type State = { ok?: boolean; message?: string; error?: string } | null;

export function ProductForm({
  product,
}: {
  product: {
    id: string;
    title: string;
    description: string;
    brand: string | null;
    category: string;
    status: string;
    attributeLines: string;
  };
}) {
  const [state, action, pending] = useActionState<State, FormData>(updateProductAction, null);

  return (
    <Card>
      <CardBody>
        <form action={action} className="space-y-4">
          <input type="hidden" name="productId" value={product.id} />

          {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
          {state?.ok ? <Alert tone="success">{state.message}</Alert> : null}

          <Field label="Title">
            <Input name="title" defaultValue={product.title} required />
          </Field>

          <Field
            label="Description"
            hint="This text is what AI agents read. Specific, factual detail makes the product easier to match."
          >
            <Textarea name="description" rows={5} defaultValue={product.description} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Category">
              <Input name="category" defaultValue={product.category} required />
            </Field>
            <Field label="Brand">
              <Input name="brand" defaultValue={product.brand ?? ""} />
            </Field>
            <Field label="Status">
              <Select name="status" defaultValue={product.status}>
                <option value="active">Active</option>
                <option value="draft">Draft</option>
                <option value="archived">Archived</option>
              </Select>
            </Field>
          </div>

          <Field
            label="Specifications"
            hint="One per line, as key: value. Agents filter on these, so a thin list makes the product hard to match. Commas make a list."
          >
            <Textarea
              name="attributes"
              rows={5}
              className="font-mono text-xs"
              defaultValue={product.attributeLines}
              placeholder={"gender: unisex\nuse: road running\ndrop mm: 8"}
            />
          </Field>

          <Button type="submit" disabled={pending}>
            {pending ? "Saving and re-indexing…" : "Save product"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

export function VariantRow({
  variant,
  productId,
}: {
  variant: {
    id: string;
    sku: string;
    isOnlyVariant?: boolean;
    attributes: Record<string, string>;
    priceMinor: number;
    quantity: number;
    reserved: number;
    lowStockThreshold: number;
    active: boolean;
    windowStartsAt: string | null;
    windowEndsAt: string | null;
    inWindow: boolean;
  };
  productId: string;
}) {
  const [state, action, pending] = useActionState<State, FormData>(updateVariantAction, null);
  const available = Math.max(variant.quantity - variant.reserved, 0);

  return (
    <form action={action} className="border-b border-border px-5 py-3 last:border-0">
      <input type="hidden" name="variantId" value={variant.id} />
      <input type="hidden" name="productId" value={productId} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-40 flex-1">
          <p className="text-sm font-medium">
            {Object.entries(variant.attributes).map(([k, v]) => `${k} ${v}`).join(" · ") || "Default"}
          </p>
          <p className="font-mono text-xs text-subtle">{variant.sku}</p>
        </div>

        <label className="w-28">
          <span className="mb-1 block text-xs text-muted-foreground">Price (₹)</span>
          <Input name="price" type="number" step="0.01" min="1" defaultValue={toMajor(variant.priceMinor)} />
        </label>

        <label className="w-24">
          <span className="mb-1 block text-xs text-muted-foreground">Stock</span>
          <Input name="quantity" type="number" min="0" defaultValue={variant.quantity} />
        </label>

        <label className="w-28">
          <span className="mb-1 block text-xs text-muted-foreground">Low-stock at</span>
          <Input name="lowStockThreshold" type="number" min="0" defaultValue={variant.lowStockThreshold} />
        </label>

        <label className="flex items-center gap-1.5 pb-2 text-xs text-muted-foreground">
          <input type="checkbox" name="active" defaultChecked={variant.active} className="accent-[var(--primary)]" />
          For sale
        </label>

        <Button type="submit" size="sm" variant="secondary" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>

        <WithdrawVariantButton
          variantId={variant.id}
          productId={productId}
          disabled={Boolean(variant.isOnlyVariant)}
        />
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {variant.reserved > 0 ? (
          <Badge tone="info">{variant.reserved} held by checkouts in progress</Badge>
        ) : null}
        <Badge tone={available === 0 ? "danger" : available <= variant.lowStockThreshold ? "warning" : "neutral"}>
          {available} available to sell
        </Badge>
        {!variant.active ? <Badge tone="neutral">withdrawn from sale</Badge> : null}
        {variant.windowStartsAt || variant.windowEndsAt ? (
          <Badge tone={variant.inWindow ? "success" : "warning"}>
            {variant.inWindow ? "inside sale window" : "outside sale window"}
          </Badge>
        ) : null}
        <AvailabilityWindowForm
          variantId={variant.id}
          productId={productId}
          startsAt={variant.windowStartsAt}
          endsAt={variant.windowEndsAt}
        />
        {state?.error ? <span className="text-xs text-danger">{state.error}</span> : null}
        {state?.ok ? <span className="text-xs text-success">{state.message}</span> : null}
      </div>
    </form>
  );
}
