import Image from "next/image";
import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { StarDisplay } from "@/components/reviews/star-rating";
import { formatMoney } from "@/lib/money";

/**
 * One product, as a card. The single card used by browse and by "For you".
 *
 * They were briefly two components and immediately began to drift — only one
 * showed the sale price, only one linked the variant image. A card is exactly
 * the kind of thing that is copied rather than shared and then quietly diverges,
 * so there is one, and the differences between surfaces are props.
 */
export type ProductCardItem = {
  productId: string;
  title: string;
  brand: string | null;
  category: string;
  merchantName: string;
  priceMinor: number;
  compareAtPriceMinor?: number | null;
  currency: string;
  imageUrl: string | null;
  ratingBp: number | null;
  ratingCount: number;
  inStock?: boolean;
};

export function ProductCard({
  item,
  /** Why this product is being shown here, when the surface has a reason. */
  reasons,
}: {
  item: ProductCardItem;
  reasons?: string[];
}) {
  const onSale = item.compareAtPriceMinor != null && item.compareAtPriceMinor > item.priceMinor;

  return (
    <Card className="overflow-hidden py-0">
      <Link
        href={`/product/${item.productId}`}
        className="flex h-full w-full flex-col text-left transition-colors hover:bg-muted/50"
      >
        <div className="relative aspect-square w-full overflow-hidden bg-muted">
          {item.imageUrl ? (
            <Image
              src={item.imageUrl}
              alt=""
              width={400}
              height={400}
              unoptimized
              className="size-full object-cover"
            />
          ) : null}
          {item.inStock === false ? (
            <span className="absolute top-2 left-2">
              <Badge tone="neutral">Out of stock</Badge>
            </span>
          ) : null}
        </div>

        <div className="flex flex-1 flex-col gap-1 p-3">
          <p className="truncate text-xs text-muted-foreground">
            {item.brand ? `${item.brand} · ` : ""}
            {item.merchantName}
          </p>
          <p className="line-clamp-2 text-sm font-medium">{item.title}</p>
          <p className="truncate text-xs text-subtle">{item.category}</p>
          {item.ratingBp ? (
            <StarDisplay stars={item.ratingBp / 1000} count={item.ratingCount} />
          ) : null}
          <p className="mt-auto flex items-baseline gap-1.5 pt-1">
            <span className="tabular text-sm font-semibold">
              {formatMoney(item.priceMinor, item.currency)}
            </span>
            {onSale ? (
              <span className="tabular text-xs text-subtle line-through">
                {formatMoney(item.compareAtPriceMinor!, item.currency)}
              </span>
            ) : null}
          </p>

          {/*
            * The reason travels with the product, not with the shelf heading.
            * A shelf can only say what it is broadly about; this says why THIS
            * one is here, which is the difference between a personalised page
            * and a page that claims to be one.
            */}
          {reasons && reasons.length > 0 ? (
            <p className="mt-1 border-t border-border pt-1.5 text-xs text-muted-foreground">
              {reasons.join(" · ")}
            </p>
          ) : null}
        </div>
      </Link>
    </Card>
  );
}
