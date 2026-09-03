"use client";

import Image from "next/image";
import Link from "next/link";
import { Card } from "@/components/ui";
import { StarDisplay } from "@/components/reviews/star-rating";
import { formatMoney } from "@/lib/money";
import type { FeaturedProduct } from "@/server/catalog/featured";

/**
 * Landing merchandising, ranked by units actually sold in the last 30 days.
 *
 * Cards link straight to the product. Handing the title back to the agent as a
 * search made a shopper who had already chosen something start over from a
 * query, and re-derived by keyword what was already known exactly.
 */
export function FeaturedGrid({ products }: { products: FeaturedProduct[] }) {
  if (products.length === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold">Popular across the marketplace</h2>
      <p className="mt-0.5 mb-4 text-sm text-muted-foreground">
        Ranked by units actually sold in the last 30 days. Pick one to see it in full.
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {products.map((product) => (
          <Card key={product.productId} className="overflow-hidden py-0">
            <Link
              href={`/product/${product.productId}`}
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
            </Link>
          </Card>
        ))}
      </div>
    </section>
  );
}
