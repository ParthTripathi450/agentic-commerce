import Image from "next/image";
import Link from "next/link";
import { Badge, Card, EmptyState } from "@/components/ui";
import { StarDisplay } from "@/components/reviews/star-rating";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { BrowseItem, BrowseResult } from "@/lib/browse";

/**
 * The catalogue grid. A server component on purpose — the rows come from the
 * URL, so there is nothing to hold in client state and nothing to hydrate.
 */
export function BrowseGrid({ result, href }: { result: BrowseResult; href: (page: number) => string }) {
  if (result.items.length === 0) {
    return (
      <EmptyState title="Nothing matches those filters">
        Widen the price range, or clear a filter or two. Browse only ever shows products that really
        exist in the catalogue, so an empty result means there are none — not that it gave up.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {result.items.map((item) => (
          <ProductCard key={item.productId} item={item} />
        ))}
      </div>
      <Pagination page={result.page} pageCount={result.pageCount} href={href} />
    </div>
  );
}

function ProductCard({ item }: { item: BrowseItem }) {
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
          {!item.inStock ? (
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
        </div>
      </Link>
    </Card>
  );
}

/**
 * Links, not buttons — a page of a catalogue is a place, so it should be
 * shareable and reachable with the browser's own back and forward.
 */
function Pagination({
  page,
  pageCount,
  href,
}: {
  page: number;
  pageCount: number;
  href: (page: number) => string;
}) {
  if (pageCount <= 1) return null;

  // A window around the current page: a 21-page catalogue must not render 21
  // links, and the first and last are always worth keeping reachable.
  const window = new Set([1, pageCount, page, page - 1, page + 1]);
  const pages = [...window].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);

  const link = (p: number, label: string, disabled = false) =>
    disabled ? (
      <span key={label} className="px-2.5 py-1 text-sm text-subtle">
        {label}
      </span>
    ) : (
      <Link
        key={label}
        href={href(p)}
        scroll
        className={cn(
          "rounded-lg border px-2.5 py-1 text-sm transition-colors",
          p === page
            ? "border-primary bg-primary font-medium text-primary-foreground"
            : "border-border hover:border-primary hover:text-primary",
        )}
      >
        {label}
      </Link>
    );

  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center gap-1.5">
      {link(page - 1, "Previous", page === 1)}
      {pages.map((p, i) => (
        <span key={p} className="flex items-center gap-1.5">
          {i > 0 && p - pages[i - 1] > 1 ? <span className="text-subtle">…</span> : null}
          {link(p, String(p))}
        </span>
      ))}
      {link(page + 1, "Next", page === pageCount)}
    </nav>
  );
}
