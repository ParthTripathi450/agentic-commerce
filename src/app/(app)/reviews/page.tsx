import { PageHeader } from "@/components/page-header";
import { BackLink } from "@/components/back-link";
import { LinkButton } from "@/components/ui";
import { ReviewList } from "@/components/reviews/review-list";
import { requireCustomer } from "@/lib/session";
import { getReviewsByUser, getReviewableLines } from "@/server/reviews/queries";

/** Reviews this shopper has written, and what they could still review. */
export default async function MyReviews() {
  const user = await requireCustomer();
  const [reviews, reviewable] = await Promise.all([
    getReviewsByUser(user.id),
    getReviewableLines(user.id),
  ]);

  return (
    <div className="space-y-5">
      <BackLink fallback="/orders" label="Back to orders" />
      <PageHeader
        title="Your reviews"
        description={
          reviews.length > 0
            ? `${reviews.length} review${reviews.length === 1 ? "" : "s"} you have written.`
            : "You have not reviewed anything yet."
        }
        actions={
          reviewable.length > 0 ? (
            <LinkButton href="/orders">
              {reviewable.length} item{reviewable.length === 1 ? "" : "s"} to review
            </LinkButton>
          ) : undefined
        }
      />

      <ReviewList
        reviews={reviews}
        showProduct
        emptyTitle="No reviews yet"
        emptyBody="Once an order is delivered you can review it from Your orders."
      />
    </div>
  );
}
