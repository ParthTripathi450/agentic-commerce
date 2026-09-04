import Link from "next/link";
import { desc, eq, inArray } from "drizzle-orm";
import { Badge, Card, CardBody, EmptyState, LinkButton, type Tone } from "@/components/ui";
import { PageHeader } from "@/components/page-header";
import { ReviewControl } from "@/components/reviews/review-form";
import { MerchantReviewControl } from "@/components/reviews/merchant-review";
import { StarDisplay } from "@/components/reviews/star-rating";
import { db } from "@/db";
import { merchantPolicies, merchants, orderItems, orders, payments, productReviews, productVariants } from "@/db/schema";
import { formatMoney } from "@/lib/money";
import { RefundRequest } from "@/components/cart/refund-request";
import { formatAddress } from "@/server/commerce/addresses";
import { requireCustomer } from "@/lib/session";
import { getMerchantRatings, getMerchantReviewsByOrder } from "@/server/reviews/queries";

const STATE: Record<string, { tone: Tone; label: string }> = {
  paid: { tone: "success", label: "Paid" },
  fulfilled: { tone: "success", label: "Delivered" },
  pending_payment: { tone: "warning", label: "Awaiting payment" },
  payment_failed: { tone: "danger", label: "Payment failed" },
  canceled: { tone: "neutral", label: "Cancelled" },
  refunded: { tone: "info", label: "Refunded" },
};

export default async function OrdersPage() {
  const user = await requireCustomer();

  const rows = await db
    .select({
      order: orders,
      merchantName: merchants.name,
      merchantId: merchants.id,
      paymentState: payments.state,
      failureReason: payments.failureReason,
      returnWindowDays: merchantPolicies.returnWindowDays,
      returnsAccepted: merchantPolicies.returnsAccepted,
    })
    .from(orders)
    .innerJoin(merchants, eq(merchants.id, orders.merchantId))
    .leftJoin(payments, eq(payments.orderId, orders.id))
    .leftJoin(merchantPolicies, eq(merchantPolicies.merchantId, orders.merchantId))
    .where(eq(orders.userId, user.id))
    .orderBy(desc(orders.createdAt))
    .limit(30);

  const orderIds = rows.map((r) => r.order.id);

  const [items, reviews, merchantReviewsByOrder, merchantRatings] = await Promise.all([
    orderIds.length
      ? db
          .select({
            item: orderItems,
            productId: productVariants.productId,
          })
          .from(orderItems)
          .innerJoin(productVariants, eq(productVariants.id, orderItems.variantId))
          .where(inArray(orderItems.orderId, orderIds))
      : Promise.resolve([]),
    orderIds.length
      ? db.select().from(productReviews).where(inArray(productReviews.orderId, orderIds))
      : Promise.resolve([]),
    getMerchantReviewsByOrder(orderIds),
    getMerchantRatings([...new Set(rows.map((r) => r.merchantId))]),
  ]);

  const itemsByOrder = new Map<string, typeof items>();
  for (const row of items) {
    const list = itemsByOrder.get(row.item.orderId) ?? [];
    list.push(row);
    itemsByOrder.set(row.item.orderId, list);
  }
  const reviewByLine = new Map(reviews.map((r) => [`${r.orderId}:${r.variantId}`, r]));

  const reviewable = rows.filter(
    (r) => r.order.state === "paid" || r.order.state === "fulfilled",
  ).length;

  return (
    <div>
      <PageHeader
        title="Your orders"
        description="Every purchase, including the ones an agent prepared and you authorized. Rate what you have received — your rating changes how these products rank for other shoppers."
        actions={
          <LinkButton href="/support" variant="secondary">
            Contact a merchant
          </LinkButton>
        }
      />

      {rows.length === 0 ? (
        <EmptyState title="No orders yet">
          <Link href="/shop" className="text-primary hover:underline">
            Ask the shopping agent to find something.
          </Link>
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {reviewable > 0 ? (
            <p className="text-sm text-muted-foreground">
              {reviewable} order{reviewable === 1 ? "" : "s"} you can review.
            </p>
          ) : null}

          {rows.map(({ order, merchantName, paymentState, failureReason, returnWindowDays, returnsAccepted }) => {
            const state = STATE[order.state] ?? { tone: "neutral" as Tone, label: order.state };
            const lines = itemsByOrder.get(order.id) ?? [];
            const canReview = order.state === "paid" || order.state === "fulfilled";

            /*
             * The returns window, computed here so the control only appears
             * while it is genuinely open. A button that shows and then refuses
             * is worse than none — the shopper has decided by the time they
             * are told no.
             */
            const windowDays = returnWindowDays ?? 7;
            const elapsed = Math.floor((Date.now() - order.createdAt.getTime()) / 86_400_000);
            const refundable =
              (returnsAccepted ?? true) &&
              paymentState === "captured" &&
              (order.state === "paid" || order.state === "fulfilled") &&
              elapsed <= windowDays;

            return (
              <Card key={order.id}>
                <CardBody className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">
                          {order.orderNumber}
                        </span>
                        <Badge tone={state.tone}>{state.label}</Badge>
                        {order.placedByAgent ? <Badge tone="accent">agent purchase</Badge> : null}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium">{merchantName}</p>
                        {merchantRatings.get(order.merchantId)?.productRatingBp ? (
                          <StarDisplay
                            stars={(merchantRatings.get(order.merchantId)!.productRatingBp ?? 0) / 1000}
                            count={merchantRatings.get(order.merchantId)!.productReviewCount}
                          />
                        ) : null}
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="tabular text-base font-semibold">
                        {formatMoney(order.totals.totalMinor, order.totals.currency)}
                      </p>
                      <p className="text-xs text-subtle">
                        {order.createdAt.toLocaleDateString("en-IN", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </p>
                    </div>
                  </div>

                  {order.shippingAddress ? (
                    <p className="text-xs text-subtle">
                      Delivered to {formatAddress(order.shippingAddress)}
                    </p>
                  ) : null}

                  <ul className="space-y-3 border-t border-border pt-3">
                    {lines.map(({ item, productId }) => {
                      const review = reviewByLine.get(`${order.id}:${item.variantId}`);
                      return (
                        <li key={item.id}>
                          <p className="text-sm">
                            {item.quantity}× {item.titleSnapshot}
                            <span className="text-muted-foreground">
                              {" "}
                              (
                              {Object.entries(item.attributesSnapshot)
                                .map(([k, v]) => `${k} ${v}`)
                                .join(", ")}
                              )
                            </span>
                          </p>
                          {canReview ? (
                            <div className="mt-1.5">
                              <ReviewControl
                                orderId={order.id}
                                variantId={item.variantId}
                                productTitle={item.titleSnapshot}
                                existingStars={review ? review.ratingBp / 1000 : null}
                                existingTitle={review?.title ?? null}
                                existingBody={review?.body ?? null}
                              />
                            </div>
                          ) : null}
                          <span className="sr-only">{productId}</span>
                        </li>
                      );
                    })}
                  </ul>

                  {canReview ? (
                    <div className="border-t border-border pt-3">
                      <MerchantReviewControl
                        orderId={order.id}
                        merchantName={merchantName}
                        existingStars={
                          merchantReviewsByOrder.get(order.id)
                            ? merchantReviewsByOrder.get(order.id)!.ratingBp / 1000
                            : null
                        }
                        existingComment={merchantReviewsByOrder.get(order.id)?.comment ?? null}
                      />
                    </div>
                  ) : null}

                  {order.state === "payment_failed" && failureReason ? (
                    <p className="text-xs text-danger">
                      Payment did not go through: {failureReason}. You were not charged.
                    </p>
                  ) : null}
                  {paymentState === "captured" ? (
                    <p className="text-xs text-subtle">Paid via Razorpay test mode.</p>
                  ) : null}

                  {refundable ? (
                    <RefundRequest orderId={order.id} daysLeft={windowDays - elapsed} />
                  ) : null}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
