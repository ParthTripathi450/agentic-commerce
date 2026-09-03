"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Check, ShoppingCart } from "lucide-react";
import { Alert, Badge, Button, Card, CardBody } from "@/components/ui";
import { StarDisplay } from "@/components/reviews/star-rating";
import { QuantityStepper } from "@/components/cart/quantity-stepper";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { addToCartAction } from "@/server/commerce/cart-actions";
import type { ProductDetail } from "@/server/catalog/product-page";
import { QualityBars, extractQualities, humanizeQuality } from "./quality-bars";

/**
 * One product, everything needed to decide, and one way to act.
 *
 * Add to cart only — the same single route into the basket the agent results
 * use, so there is one place for a purchase to go wrong instead of two.
 */
export function ProductDetailView({ product }: { product: ProductDetail }) {
  const router = useRouter();
  const [variantId, setVariantId] = useState(
    product.defaultVariantId ?? product.variants[0]?.variantId ?? "",
  );
  const [quantity, setQuantity] = useState(1);
  const [pending, start] = useTransition();
  const [added, setAdded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const variant = product.variants.find((v) => v.variantId === variantId);
  const qualities = extractQualities(product.attributes);
  // Everything except the rated features, which get their own block above.
  const specs = Object.fromEntries(
    Object.entries(product.attributes as Record<string, unknown>).filter(
      ([key]) => key !== "qualities",
    ),
  );
  const outOfStock = !variant || variant.availableQuantity === 0;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardBody className="p-0">
          <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-surface-2">
            {product.imageUrls[0] ? (
              <Image
                src={product.imageUrls[0]}
                alt={product.title}
                fill
                sizes="(min-width: 768px) 50vw, 100vw"
                className="object-cover"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                No image
              </div>
            )}
          </div>
        </CardBody>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardBody className="space-y-3">
            <div className="space-y-0.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                {/* The figure tracks quantity: a price that ignores the stepper
                    is the number the shopper is actually deciding on, wrong. */}
                <span className="tabular text-2xl font-semibold">
                  {variant ? formatMoney(variant.priceMinor * quantity, variant.currency) : "—"}
                </span>
                {variant?.compareAtPriceMinor ? (
                  <span className="tabular text-sm text-muted-foreground line-through">
                    {formatMoney(variant.compareAtPriceMinor * quantity, variant.currency)}
                  </span>
                ) : null}
              </div>
              {variant && quantity > 1 ? (
                <p className="text-xs text-muted-foreground">
                  {quantity} × {formatMoney(variant.priceMinor, variant.currency)} each
                </p>
              ) : null}
            </div>

            {product.ratingBp ? (
              <div className="flex items-center gap-2">
                <StarDisplay stars={product.ratingBp / 1000} count={product.ratingCount} />
              </div>
            ) : null}

            <p className="text-sm leading-relaxed text-muted-foreground">{product.description}</p>

            {/* Options, with stock shown per choice rather than discovered at checkout. */}
            {product.variants.length > 1 ? (
              <div className="space-y-1.5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Options
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {product.variants.map((v) => {
                    const label = Object.values(v.attributes).join(" · ") || v.sku;
                    const disabled = v.availableQuantity === 0;
                    return (
                      <button
                        key={v.variantId}
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          setVariantId(v.variantId);
                          setAdded(false);
                        }}
                        className={cn(
                          "rounded-full border px-3 py-1.5 text-xs transition-colors",
                          v.variantId === variantId
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border hover:bg-surface-2",
                          disabled && "cursor-not-allowed opacity-40 line-through",
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <QuantityStepper
                size="sm"
                value={quantity}
                max={Math.max(1, variant?.availableQuantity ?? 1)}
                onChange={setQuantity}
              />
              <Button
                disabled={pending || outOfStock}
                onClick={() =>
                  start(async () => {
                    const form = new FormData();
                    form.set("variantId", variantId);
                    form.set("quantity", String(quantity));
                    const result = await addToCartAction(null, form);
                    if (result?.error) setError(result.error);
                    else {
                      setError(null);
                      setAdded(true);
                      router.refresh();
                    }
                  })
                }
              >
                <ShoppingCart className="size-4" />
                {pending ? "Adding…" : outOfStock ? "Out of stock" : "Add to cart"}
              </Button>
            </div>

            {added ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-success/30 bg-success-soft/40 px-3 py-2">
                <Check className="size-4 text-success" aria-hidden />
                <span className="text-sm">In your cart.</span>
                <Button size="sm" variant="ghost" onClick={() => router.push("/cart")}>
                  Go to cart
                </Button>
                <Button size="sm" onClick={() => router.push("/checkout")}>
                  Proceed to pay
                </Button>
              </div>
            ) : null}

            {error ? <Alert tone="danger">{error}</Alert> : null}

            <p className="text-xs text-muted-foreground">
              {product.merchant.returnsAccepted
                ? `${product.merchant.returnWindowDays}-day returns`
                : "No returns"}{" "}
              · delivered in about {product.merchant.standardDeliveryDays} days ·{" "}
              {variant ? `${variant.availableQuantity} in stock` : "unavailable"}
            </p>
          </CardBody>
        </Card>

        {/*
          * Rated features first, and separately from the spec sheet.
          *
          * These used to fall through `String(value)` on the qualities object
          * and render as "[object Object]" — so someone searching for
          * waterproof shoes could not see the water-resistance rating that
          * answered their question.
          */}
        {Object.keys(qualities).length > 0 ? (
          <Card>
            <CardBody className="space-y-2.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Features
              </p>
              <QualityBars qualities={qualities} />
            </CardBody>
          </Card>
        ) : null}

        {Object.keys(specs).length > 0 ? (
          <Card>
            <CardBody className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Specifications
              </p>
              <dl className="grid gap-1.5 text-sm sm:grid-cols-2">
                {Object.entries(specs).map(([key, value]) => (
                  <div key={key} className="flex justify-between gap-3 border-b border-border py-1">
                    <dt className="text-muted-foreground">{humanizeQuality(key)}</dt>
                    <dd className="text-right font-medium">
                      {Array.isArray(value)
                        ? value.join(", ")
                        : typeof value === "boolean"
                          ? value ? "Yes" : "No"
                          : String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </CardBody>
          </Card>
        ) : null}

        {product.searchTags.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {product.searchTags.slice(0, 10).map((tag) => (
              <Badge key={tag} tone="neutral">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
