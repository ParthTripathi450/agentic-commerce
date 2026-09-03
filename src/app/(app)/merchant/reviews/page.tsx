import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Card, CardBody } from "@/components/ui";
import { RatingSummary, ReviewList } from "@/components/reviews/review-list";
import { requireMerchant } from "@/lib/session";
import { getMerchantProductReviews } from "@/server/reviews/queries";

/**
 * What customers said about this merchant's products.
 *
 * `?critical=1` filters to 3 stars and below — the reviews worth acting on. A
 * feed that opens on the praise is pleasant and useless.
 */
export default async function MerchantReviews({
  searchParams,
}: {
  searchParams: Promise<{ critical?: string }>;
}) {
  const { merchant } = await requireMerchant();
  const { critical } = await searchParams;
  const onlyCritical = critical === "1";

  const { reviews, breakdown } = await getMerchantProductReviews(merchant.id, {
    limit: 60,
    maxStars: onlyCritical ? 3 : undefined,
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reviews"
        description={
          breakdown.total > 0
            ? `${breakdown.total} reviews across your products, averaging ${(breakdown.averageBp / 1000).toFixed(1)} out of 5.`
            : "No one has reviewed your products yet."
        }
      />

      {breakdown.total > 0 ? (
        <Card>
          <CardBody className="space-y-4">
            <RatingSummary breakdown={breakdown} />
            <div className="flex flex-wrap gap-2 border-t border-border pt-3 text-sm">
              <Link
                href="/merchant/reviews"
                className={onlyCritical ? "text-muted-foreground hover:text-foreground" : "font-medium text-primary"}
              >
                All reviews
              </Link>
              <span className="text-subtle">·</span>
              <Link
                href="/merchant/reviews?critical=1"
                className={onlyCritical ? "font-medium text-primary" : "text-muted-foreground hover:text-foreground"}
              >
                Needs attention (3★ and below)
              </Link>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <ReviewList
        reviews={reviews}
        showProduct
        emptyTitle={onlyCritical ? "Nothing below 4 stars" : "No reviews yet"}
        emptyBody={
          onlyCritical
            ? "Every review you have is 4 stars or better."
            : "Reviews appear here once a customer who bought something writes one."
        }
      />
    </div>
  );
}
