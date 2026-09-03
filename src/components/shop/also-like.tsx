"use client";

import { useEffect, useState, useTransition } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ShoppingCart } from "lucide-react";
import { Badge, Button, Card, CardBody } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { addToCartAction } from "@/server/commerce/cart-actions";

type Recommendation = {
  productId: string;
  category: string;
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
  const [upsell, setUpsell] = useState<Recommendation[]>([]);
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
        if (cancelled) return;
        setItems(d.crossSell ?? d.recommendations ?? []);
        setUpsell(d.upsell ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setItems([]);
          setUpsell([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [productId]);

  if (loading || (items.length === 0 && upsell.length === 0)) return null;

  return (
    <div className="space-y-4">
      {items.length > 0 ? (
        <Card>
          <CardBody className="space-y-3">
            <div>
              <p className="text-sm font-semibold">Goes with {title}</p>
              <p className="text-xs text-muted-foreground">
                Complementary items — what people actually pair with this, not more of the same.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {items.map((item) => (
                <RecommendationCard key={item.variantId} item={item} />
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      {upsell.length > 0 ? (
        <Card>
          <CardBody className="space-y-3">
            <div>
              <p className="text-sm font-semibold">A step up</p>
              <p className="text-xs text-muted-foreground">
                Rated higher than what you picked, and priced accordingly — shown so the choice is
                yours rather than hidden.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {upsell.map((item) => (
                <RecommendationCard key={item.variantId} item={item} />
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

function RecommendationCard({ item }: { item: Recommendation }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [added, setAdded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex gap-3 rounded-lg border border-border p-3 transition-colors hover:border-primary/40">
      {/* The whole card is a link: a recommendation you cannot open is a dead end. */}
      <Link
        href={`/product/${item.productId}`}
        className="relative size-16 shrink-0 overflow-hidden rounded-md bg-surface-2"
        aria-label={`View ${item.title}`}
      >
        {item.imageUrl ? (
          <Image src={item.imageUrl} alt="" fill sizes="64px" className="object-cover" />
        ) : null}
      </Link>
      <div className="min-w-0 flex-1 space-y-1.5">
        <Link href={`/product/${item.productId}`} className="block">
          <p className="truncate text-sm font-medium hover:text-primary hover:underline">
            {item.title}
          </p>
        </Link>
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
