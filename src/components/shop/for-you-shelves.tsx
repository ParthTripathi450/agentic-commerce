import Link from "next/link";
import { Sparkles } from "lucide-react";
import { Alert, Card, CardBody, LinkButton } from "@/components/ui";
import { ProductCard } from "@/components/shop/product-card";
import type { ForYou } from "@/server/shopper/for-you";

/**
 * The suggestion shelves.
 *
 * Each shelf leads with WHY it exists, in the shopper's own history. That
 * sentence is the difference between a personalised page and a page that says
 * it is personalised — and it is checkable, because everything it claims is
 * visible on /preferences.
 */
export function ForYouShelves({ forYou }: { forYou: ForYou }) {
  if (forYou.isCold) {
    return (
      <div className="space-y-4">
        <Alert tone="neutral" title="Not enough to go on yet">
          There is no honest way to pick things for you until you have bought, reviewed or browsed a
          few. Rather than dress up the bestseller list as “picked for you”, this page waits.
        </Alert>
        <div className="flex flex-wrap gap-2">
          <LinkButton href="/browse">Browse the catalogue</LinkButton>
          <LinkButton href="/shop" variant="secondary">
            Ask the agent instead
          </LinkButton>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {forYou.shelves.map((shelf) => (
        <section key={shelf.id}>
          <h2 className="text-sm font-semibold">{shelf.title}</h2>
          <p className="mt-0.5 mb-4 text-sm text-muted-foreground">{shelf.because}</p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {shelf.items.map((item) => (
              <ProductCard key={item.productId} item={item} reasons={item.reasons} />
            ))}
          </div>
        </section>
      ))}

      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            <Sparkles className="mr-1.5 inline size-3.5" aria-hidden />
            Every suggestion here comes from your own orders, reviews and browsing — nothing else.
          </p>
          <Link
            href="/preferences"
            className="text-sm text-primary underline underline-offset-4 hover:text-primary/80"
          >
            See what the agent knows
          </Link>
        </CardBody>
      </Card>
    </div>
  );
}
