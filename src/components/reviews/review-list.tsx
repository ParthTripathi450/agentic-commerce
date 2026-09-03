import { Badge, Card, CardBody, EmptyState } from "@/components/ui";
import { StarDisplay } from "@/components/reviews/star-rating";
import type { RatingBreakdown, ReviewWithContext } from "@/server/reviews/queries";
import Link from "next/link";

/**
 * Reviews, with the rating distribution above them.
 *
 * The histogram matters more than the average: "4.2 from 900" hides whether
 * that is everyone agreeing or a split between delighted and furious, and those
 * are different products to buy.
 */
export function RatingSummary({ breakdown }: { breakdown: RatingBreakdown }) {
  if (breakdown.total === 0) return null;
  const max = Math.max(...Object.values(breakdown.histogram), 1);

  return (
    <div className="flex flex-wrap items-center gap-6">
      <div>
        <p className="text-3xl font-semibold tabular">
          {(breakdown.averageBp / 1000).toFixed(1)}
        </p>
        <StarDisplay stars={breakdown.averageBp / 1000} count={breakdown.total} />
      </div>
      <dl className="min-w-48 flex-1 space-y-1">
        {[5, 4, 3, 2, 1].map((star) => (
          <div key={star} className="flex items-center gap-2 text-xs">
            <dt className="w-8 shrink-0 text-muted-foreground">{star}★</dt>
            <dd className="flex flex-1 items-center gap-2">
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
                <span
                  className="block h-full rounded-full bg-best-match"
                  style={{ width: `${(breakdown.histogram[star] / max) * 100}%` }}
                />
              </span>
              <span className="tabular w-10 text-right text-muted-foreground">
                {breakdown.histogram[star]}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function ReviewList({
  reviews,
  showProduct = false,
  emptyTitle = "No reviews yet",
  emptyBody,
}: {
  reviews: ReviewWithContext[];
  /** Merchant and "my reviews" views span products, so name it on each card. */
  showProduct?: boolean;
  emptyTitle?: string;
  emptyBody?: string;
}) {
  if (reviews.length === 0) {
    return <EmptyState title={emptyTitle}>{emptyBody}</EmptyState>;
  }

  return (
    <ul className="space-y-3">
      {reviews.map((review) => (
        <li key={review.id}>
          <Card>
            <CardBody className="space-y-2">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  {showProduct ? (
                    <Link
                      href={`/product/${review.productId}`}
                      className="text-sm font-medium hover:text-primary hover:underline"
                    >
                      {review.productTitle}
                    </Link>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <StarDisplay stars={review.ratingBp / 1000} />
                    {review.title ? (
                      <span className="text-sm font-medium">{review.title}</span>
                    ) : null}
                  </div>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {review.createdAt.toLocaleDateString("en-IN", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </span>
              </div>

              {review.body ? (
                <p className="text-sm leading-relaxed text-muted-foreground">{review.body}</p>
              ) : null}

              <div className="flex flex-wrap items-center gap-1.5">
                {/* Verified because the schema requires it — order_id is NOT NULL. */}
                <Badge tone="success">Verified purchase</Badge>
                <span className="text-xs text-muted-foreground">{review.authorName}</span>
                {Object.entries(review.variantAttributes).length > 0 ? (
                  <span className="text-xs text-subtle">
                    · {Object.values(review.variantAttributes).join(" · ")}
                  </span>
                ) : null}
              </div>
            </CardBody>
          </Card>
        </li>
      ))}
    </ul>
  );
}
