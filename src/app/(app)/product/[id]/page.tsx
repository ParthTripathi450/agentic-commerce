import { notFound } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { ProductDetailView } from "@/components/shop/product-detail";
import { AlsoLike } from "@/components/shop/also-like";
import { requireCustomer } from "@/lib/session";
import { getProductDetail } from "@/server/catalog/product-page";
import { getProductReviewsDetailed } from "@/server/reviews/queries";
import { RatingSummary, ReviewList } from "@/components/reviews/review-list";
import { Card, CardBody } from "@/components/ui";

/**
 * The shopper-facing product page.
 *
 * Reached from "Popular across the marketplace" and from recommendations, both
 * of which used to run a search instead — which made a shopper who had already
 * picked something start again from a query.
 */
export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCustomer();
  const { id } = await params;
  const product = await getProductDetail(id);
  if (!product) notFound();

  const { reviews, breakdown } = await getProductReviewsDetailed(product.productId, 20);

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title={product.title}
        description={`${product.brand ? `${product.brand} · ` : ""}${product.category} · sold by ${product.merchant.name}`}
        actions={
          <Link href="/shop" className="text-sm text-muted-foreground hover:text-foreground">
            Back to shopping
          </Link>
        }
      />
      <ProductDetailView product={product} />
      <Card>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold">
              Reviews {breakdown.total > 0 ? `(${breakdown.total})` : ""}
            </h2>
            <span className="text-xs text-muted-foreground">
              Every review is tied to a real order — the schema requires it.
            </span>
          </div>
          <RatingSummary breakdown={breakdown} />
          <ReviewList
            reviews={reviews}
            emptyTitle="No reviews yet"
            emptyBody="This one has not been reviewed. Reviews can only be left by someone who bought it."
          />
        </CardBody>
      </Card>

      <AlsoLike productId={product.productId} title={product.title} />
    </div>
  );
}
