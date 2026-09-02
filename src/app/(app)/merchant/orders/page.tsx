import { desc, eq, sql } from "drizzle-orm";
import { PageHeader } from "@/components/page-header";
import { Badge, Card, CardBody, EmptyState, type Tone } from "@/components/ui";
import { OrderActions } from "@/components/merchant/order-actions";
import { db } from "@/db";
import { orderItems, orders } from "@/db/schema";
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
      itemCount: sql<number>`(SELECT COALESCE(SUM(quantity),0) FROM ${orderItems} WHERE ${orderItems.orderId} = ${orders.id})`,
      firstItem: sql<string>`(SELECT title_snapshot FROM ${orderItems} WHERE ${orderItems.orderId} = ${orders.id} LIMIT 1)`,
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
                        <span className="text-xs text-subtle">{Number(order.itemCount)} units</span>
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
                        <OrderActions orderId={order.id} state={order.state} />
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
