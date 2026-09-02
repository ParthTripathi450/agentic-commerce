"use client";

import { useEffect, useState, useTransition } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ShoppingCart } from "lucide-react";
import { Badge, Button, Card, CardBody } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { addToCartAction } from "@/server/commerce/cart-actions";

type Recommendation = {
  productId: string;
  variantId: string;
  title: string;
  brand: string | null;
  merchantName: string;
  priceMinor: number;
  currency: string;
  imageUrl: string | null;
  reason: string;
};

/**
 * What goes with the thing just added.
 *
 * Appears at the moment a shopper is most likely to add a second item, and
 * every card says WHY it is there — "often bought with this (3 orders)" is a
 * fact about real orders, not a guess dressed as one.
 */
export function AlsoLike({ productId, title }: { productId: string; title: string }) {
  const [items, setItems] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/catalog/recommendations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, limit: 4 }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setItems(d.recommendations ?? []);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [productId]);

  if (loading || items.length === 0) return null;

  return (
    <Card>
      <CardBody className="space-y-3">
        <div>
          <p className="text-sm font-semibold">Goes with {title}</p>
          <p className="text-xs text-muted-foreground">
            From what other shoppers bought alongside it.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((item) => (
            <RecommendationCard key={item.variantId} item={item} />
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

function RecommendationCard({ item }: { item: Recommendation }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [added, setAdded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex gap-3 rounded-lg border border-border p-3">
      <div className="relative size-16 shrink-0 overflow-hidden rounded-md bg-surface-2">
        {item.imageUrl ? (
          <Image src={item.imageUrl} alt="" fill sizes="64px" className="object-cover" />
        ) : null}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="truncate text-sm font-medium">{item.title}</p>
        <p className="text-xs text-muted-foreground">{item.merchantName}</p>
        <Badge tone="neutral">{item.reason}</Badge>
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <span className="tabular text-sm font-semibold">
            {formatMoney(item.priceMinor, item.currency)}
          </span>
          <Button
            size="sm"
            variant={added ? "ghost" : "secondary"}
            disabled={pending}
            onClick={() =>
              start(async () => {
                const form = new FormData();
                form.set("variantId", item.variantId);
                form.set("quantity", "1");
                const result = await addToCartAction(null, form);
                if (result?.error) setError(result.error);
                else {
                  setAdded(true);
                  router.refresh();
                }
              })
            }
          >
            <ShoppingCart className="size-3.5" />
            {pending ? "…" : added ? "Added" : "Add"}
          </Button>
        </div>
        {error ? <p className="text-xs text-danger">{error}</p> : null}
      </div>
    </div>
  );
}
