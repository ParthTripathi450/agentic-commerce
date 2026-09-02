"use client";

import Image from "next/image";
import { Card } from "@/components/ui";
import { StarDisplay } from "@/components/reviews/star-rating";
import { formatMoney } from "@/lib/money";
import type { FeaturedProduct } from "@/server/catalog/featured";

/**
 * Landing merchandising.
 *
 * Clicking a card does not open a product page — it hands the title to the
 * shopping agent, because searching is how you buy here. The card is a prompt,
 * not a link.
 */
export function FeaturedGrid({
  products,
  onPick,
}: {
  products: FeaturedProduct[];
  onPick: (query: string) => void;
}) {
  if (products.length === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold">Popular across the marketplace</h2>
      <p className="mt-0.5 mb-4 text-sm text-muted-foreground">
        Selling most in the last 30 days. Pick one to ask the agent about it.
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {products.map((product) => (
          <Card key={product.productId} className="overflow-hidden py-0">
            <button
              type="button"
              onClick={() => onPick(product.title)}
              className="flex h-full w-full flex-col text-left transition-colors hover:bg-muted/50"
            >
              <div className="aspect-square w-full overflow-hidden bg-muted">
                {product.imageUrl ? (
                  <Image
                    src={product.imageUrl}
                    alt=""
                    width={320}
                    height={320}
                    unoptimized
                    className="size-full object-cover"
                  />
                ) : null}
              </div>

              <div className="flex flex-1 flex-col gap-1 p-3">
                <p className="text-xs text-muted-foreground">{product.merchantName}</p>
                <p className="line-clamp-2 text-sm font-medium">{product.title}</p>
                {product.ratingBp ? (
                  <StarDisplay stars={product.ratingBp / 1000} count={product.ratingCount} />
                ) : null}
                <p className="tabular mt-auto pt-1 text-sm font-semibold">
                  {formatMoney(product.priceMinor, product.currency)}
                </p>
              </div>
            </button>
          </Card>
        ))}
      </div>
    </section>
  );
}
