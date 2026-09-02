import { desc, eq, sql } from "drizzle-orm";
import { PageHeader } from "@/components/page-header";
import { Badge, Card, CardBody, EmptyState, type Tone } from "@/components/ui";
import { OrderActions } from "@/components/merchant/order-actions";
import { db } from "@/db";
import { orderItems, orders, payments } from "@/db/schema";
import { canOfferRefund } from "@/server/commerce/refund";
import { formatMoney } from "@/lib/money";
import { requireMerchant } from "@/lib/session";

const STATE_TONE: Record<string, Tone> = {
  paid: "success",
  fulfilled: "success",
  pending_payment: "warning",
  payment_failed: "danger",
  canceled: "neutral",
  refunded: "info",
};

export default async function MerchantOrders() {
  const { merchant } = await requireMerchant();

  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      state: orders.state,
      totals: orders.totals,
      placedByAgent: orders.placedByAgent,
      createdAt: orders.createdAt,
      // Inner tables are ALIASED and the outer one named in full. Interpolating
      // a column into a sql`` template renders it UNQUALIFIED ("id", not
      // "orders"."id"), so inside a correlated subquery it binds to the inner
      // table's own column: `order_items.order_id = order_items.id` is always
      // false, which silently showed "0 units" on every row.
      itemCount: sql<number>`(SELECT COALESCE(SUM(oi.quantity), 0) FROM ${orderItems} AS oi WHERE oi.order_id = orders.id)`,
      firstItem: sql<string>`(SELECT oi.title_snapshot FROM ${orderItems} AS oi WHERE oi.order_id = orders.id LIMIT 1)`,
      // Drives the Refund control: money can only go back if some came in.
      hasCapturedPayment: sql<boolean>`EXISTS (SELECT 1 FROM ${payments} AS p WHERE p.order_id = orders.id AND p.state = 'captured')`,
    })
    .from(orders)
    .where(eq(orders.merchantId, merchant.id))
    .orderBy(desc(orders.createdAt))
    .limit(50);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Orders"
        description="Your 50 most recent orders. Ones placed by an AI agent are marked, so you can see how much of your revenue now comes from agent buyers."
      />

      {rows.length === 0 ? (
        <EmptyState title="No orders yet" />
      ) : (
        <Card>
          <CardBody className="px-0 py-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-5 py-2 font-medium">Order</th>
                    <th className="px-3 py-2 font-medium">Items</th>
                    <th className="px-3 py-2 font-medium">Placed by</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 text-right font-medium">Total</th>
                    <th className="px-5 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((order) => (
                    <tr key={order.id} className="border-b border-border last:border-0">
                      <td className="px-5 py-2.5 font-mono text-xs">{order.orderNumber}</td>
                      <td className="px-3 py-2.5">
                        <span className="block max-w-56 truncate">{order.firstItem}</span>
                        <span className="text-xs text-subtle">
                          {Number(order.itemCount)} unit{Number(order.itemCount) === 1 ? "" : "s"}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        {order.placedByAgent ? (
                          <Badge tone="accent">{order.placedByAgent}</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">customer</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={STATE_TONE[order.state] ?? "neutral"}>
                          {order.state.replace(/_/g, " ")}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">
                        {order.createdAt.toLocaleDateString("en-IN", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </td>
                      <td className="tabular px-3 py-2.5 text-right font-medium">
                        {formatMoney(order.totals.totalMinor, order.totals.currency)}
                      </td>
                      <td className="px-5 py-2.5 text-right">
                        <OrderActions
                          orderId={order.id}
                          state={order.state}
                          canRefund={canOfferRefund(order.state, order.hasCapturedPayment)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
