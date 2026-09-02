"use client";

import Image from "next/image";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Alert, Badge, Button, Card, CardBody, EmptyState } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import {
  clearCartAction,
  removeCartLineAction,
  updateCartLineAction,
} from "@/server/commerce/cart-actions";
import { QuantityStepper } from "./quantity-stepper";

export type CartLineView = {
  variantId: string;
  title: string;
  attributes: Record<string, string>;
  quantity: number;
  unitPriceMinor: number;
  availableQuantity: number;
  imageUrl: string | null;
};

export type CartView = {
  cartId: string;
  merchant: { id: string; slug: string; name: string };
  lines: CartLineView[];
  totals: {
    subtotalMinor: number;
    shippingMinor: number;
    taxMinor: number;
    totalMinor: number;
    currency: string;
  };
  issues: Array<{ variantId: string; kind: string; detail: string }>;
};

export function CartList({ carts }: { carts: CartView[] }) {
  if (carts.length === 0) {
    return (
      <EmptyState title="Your cart is empty">
        Ask the shopping agent to find something, then add it here.
      </EmptyState>
    );
  }

  // Blocking issues are per-merchant, but they stop the single checkout, so
  // they have to be surfaced at the top rather than only on the offending card.
  const blocked = carts.filter((c) => c.issues.some((i) => i.kind !== "price_changed"));
  const total = carts.reduce((sum, c) => sum + c.totals.totalMinor, 0);

  return (
    <div className="space-y-4">
      {carts.length > 1 ? (
        <Alert tone="info">
          Items from {carts.length} merchants. You check out and pay <strong>once</strong>; each
          merchant still gets its own order, signed cart mandate and delivery.
        </Alert>
      ) : null}

      {carts.map((cart) => (
        <MerchantCart key={cart.cartId} cart={cart} />
      ))}

      <CheckoutAll
        cartCount={carts.length}
        totalMinor={total}
        disabled={blocked.length > 0}
        blockedReason={
          blocked.length > 0
            ? `Resolve the issue${blocked.length === 1 ? "" : "s"} above (${blocked
                .map((c) => c.merchant.name)
                .join(", ")}) before checking out.`
            : null
        }
      />
    </div>
  );
}

function MerchantCart({ cart }: { cart: CartView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const blocking = cart.issues.filter((i) => i.kind !== "price_changed");

  const mutate = (fn: () => Promise<{ ok?: boolean; error?: string } | undefined>) =>
    start(async () => {
      setError(null);
      const result = await fn();
      if (result?.error) setError(result.error);
      router.refresh();
    });

  return (
    <Card data-static="true">
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">{cart.merchant.name}</p>
            <Badge>{cart.lines.reduce((s, l) => s + l.quantity, 0)} items</Badge>
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => mutate(() => clearCartAction(cart.cartId))}
          >
            Empty this cart
          </Button>
        </div>

        {error ? <Alert tone="danger">{error}</Alert> : null}
        {blocking.length > 0 ? (
          <Alert tone="warning" title="Resolve before checking out">
            <ul className="mt-1 list-disc pl-4">
              {blocking.map((issue) => (
                <li key={issue.variantId}>{issue.detail}</li>
              ))}
            </ul>
          </Alert>
        ) : null}

        <ul className="divide-y divide-border">
          {cart.lines.map((line) => (
            <li key={line.variantId} className="flex flex-wrap items-center gap-3 py-3">
              {line.imageUrl ? (
                <Image
                  src={line.imageUrl}
                  alt=""
                  width={56}
                  height={56}
                  unoptimized
                  className="size-14 shrink-0 rounded-lg border border-border object-cover"
                />
              ) : null}

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{line.title}</p>
                <p className="text-xs text-muted-foreground">
                  {Object.entries(line.attributes)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(" · ")}
                </p>
                <p className="tabular mt-0.5 text-xs text-muted-foreground">
                  {formatMoney(line.unitPriceMinor)} each
                </p>
              </div>

              <QuantityStepper
                size="sm"
                value={line.quantity}
                max={line.availableQuantity}
                disabled={pending}
                onChange={(next) =>
                  mutate(() =>
                    updateCartLineAction({
                      cartId: cart.cartId,
                      variantId: line.variantId,
                      quantity: next,
                    }),
                  )
                }
              />

              <span className="tabular w-24 shrink-0 text-right text-sm font-semibold">
                {formatMoney(line.unitPriceMinor * line.quantity)}
              </span>

              <button
                type="button"
                aria-label={`Remove ${line.title}`}
                disabled={pending}
                onClick={() => mutate(() => removeCartLineAction(cart.cartId, line.variantId))}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
              >
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>

        <dl className="space-y-1 border-t border-border pt-3 text-sm">
          <Row label="Subtotal" value={formatMoney(cart.totals.subtotalMinor)} />
          <Row
            label="Shipping"
            value={cart.totals.shippingMinor === 0 ? "Free" : formatMoney(cart.totals.shippingMinor)}
          />
          <Row label="GST (18%)" value={formatMoney(cart.totals.taxMinor)} />
          <div className="flex justify-between border-t border-border pt-1.5 font-semibold">
            <dt>Total</dt>
            <dd className="tabular">{formatMoney(cart.totals.totalMinor)}</dd>
          </div>
        </dl>

      </CardBody>
    </Card>
  );
}

/**
 * One button for the whole cart, however many merchants are in it.
 *
 * Baskets stay separate above — different merchants, different shipping and
 * different return policies — but the shopper pays once.
 */
function CheckoutAll({
  cartCount,
  totalMinor,
  disabled,
  blockedReason,
}: {
  cartCount: number;
  totalMinor: number;
  disabled: boolean;
  blockedReason: string | null;
}) {
  const router = useRouter();
  return (
    <Card className="border-2 border-primary/30">
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium">
            {cartCount > 1
              ? `${cartCount} merchants · one payment`
              : "Ready to check out"}
          </p>
          <p className="text-xl font-semibold tabular">{formatMoney(totalMinor)}</p>
        </div>
        {blockedReason ? (
          <p className="text-xs text-danger">{blockedReason}</p>
        ) : cartCount > 1 ? (
          <p className="text-xs text-muted-foreground">
            You are charged once. Each merchant ships separately, so each delivery charge above is
            included in this total.
          </p>
        ) : null}
        <Button size="lg" className="w-full" disabled={disabled} onClick={() => router.push("/checkout")}>
          Check out
        </Button>
      </CardBody>
    </Card>
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
