import Link from "next/link";
import { Plus } from "lucide-react";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { Badge, Card, CardBody, CardHeader, CardTitle, EmptyState, LinkButton, type Tone } from "@/components/ui";
import { BarList, StatTile } from "@/components/merchant/stat-tile";
import { RevenueChart, type RangeKey } from "@/components/merchant/revenue-chart";
import { formatMoney } from "@/lib/money";
import { requireMerchant } from "@/lib/session";
import {
  getBestSellers,
  getCategoryBreakdown,
  getDemandTrends,
  getMerchantSummary,
  getRevenueSeries,
  getStockAlerts,
  type StockAlert,
} from "@/server/analytics/merchant";

const RANGE_CONFIG: Record<RangeKey, { granularity: "day" | "month" | "year"; periods: number }> = {
  "30d": { granularity: "day", periods: 30 },
  "12m": { granularity: "month", periods: 12 },
  "5y": { granularity: "year", periods: 5 },
};

/** Severity carries a word as well as a colour — never colour alone. */
const SEVERITY: Record<StockAlert["severity"], { tone: Tone; label: string }> = {
  stockout: { tone: "danger", label: "Out of stock" },
  critical: { tone: "warning", label: "Critical" },
  low: { tone: "info", label: "Low" },
};

export default async function MerchantOverview({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { merchant, user } = await requireMerchant();
  const { range } = await searchParams;
  const activeRange: RangeKey = range === "12m" || range === "5y" ? range : "30d";
  const config = RANGE_CONFIG[activeRange];

  const [summary, series, bestSellers, alerts, categories, trends] = await Promise.all([
    getMerchantSummary(merchant.id),
    getRevenueSeries(merchant.id, config.granularity, config.periods),
    getBestSellers(merchant.id, 30, 6),
    getStockAlerts(merchant.id),
    getCategoryBreakdown(merchant.id, 30),
    getDemandTrends(merchant.id, 14),
  ]);

  const declining = trends.filter((t) => t.changeBp < -2000).slice(0, 4);

  // Sparklines reuse the series already fetched for the chart — no extra query.
  const revenueSeries = series.map((p) => p.revenueMinor / 100);
  const ordersSeries = series.map((p) => p.orders);
  const aovSeries = series.map((p) => (p.orders > 0 ? p.revenueMinor / p.orders / 100 : 0));

  /** Change across the visible window, so each tile's arrow matches its own line. */
  const changeBp = (values: number[]) => {
    if (values.length < 4) return undefined;
    const half = Math.floor(values.length / 2);
    const earlier = values.slice(0, half).reduce((a, b) => a + b, 0);
    const later = values.slice(half).reduce((a, b) => a + b, 0);
    if (earlier === 0) return later > 0 ? 10_000 : 0;
    return Math.round(((later - earlier) / earlier) * 10_000);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome back, ${(user.name ?? merchant.name).split(" ")[0]}`}
        description={
          <>
            Track how {merchant.name} is selling — to people and to AI agents.{" "}
            <span className="font-mono text-xs">/{merchant.slug}</span>
          </>
        }
        actions={
          <>
            <Badge tone={summary.agentOrderShareBp > 0 ? "accent" : "neutral"}>
              {(summary.agentOrderShareBp / 100).toFixed(0)}% of orders from agents
            </Badge>
            <LinkButton href="/merchant/products/new" size="sm">
              <Plus className="size-4" />
              Add product
            </LinkButton>
          </>
        }
      />

      {/* Range filters, mirroring the chips in the reference layout. */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {(
          [
            { key: "30d", label: "Last 30 days" },
            { key: "12m", label: "Last 12 months" },
            { key: "5y", label: "Last 5 years" },
          ] as const
        ).map((option) => (
          <Link
            key={option.key}
            href={`/merchant?range=${option.key}`}
            aria-current={activeRange === option.key ? "true" : undefined}
            className={
              activeRange === option.key
                ? "inline-flex items-center gap-1.5 rounded-lg border border-primary bg-primary-soft px-3 py-1.5 text-xs font-medium text-accent-foreground"
                : "inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted"
            }
          >
            {option.label}
          </Link>
        ))}
        <span className="text-xs text-subtle">
          {summary.orders.allTime} orders all time · {summary.pendingOrders} pending ·{" "}
          {summary.failedPayments} failed payments
        </span>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          hero
          label="Revenue this month"
          value={formatMoney(summary.revenue.monthMinor)}
          deltaBp={summary.revenueChangeBp}
          hint="vs same point last month"
          series={revenueSeries}
        />
        <StatTile
          label="Orders"
          value={String(summary.orders.month)}
          deltaBp={changeBp(ordersSeries)}
          hint="this month"
          series={ordersSeries}
        />
        <StatTile
          label="Average order value"
          value={formatMoney(summary.averageOrderValueMinor)}
          deltaBp={changeBp(aovSeries)}
          hint="across the window"
          series={aovSeries}
        />
        <StatTile
          label="Today"
          value={formatMoney(summary.revenue.todayMinor)}
          hint={`${summary.orders.today} orders today`}
          series={revenueSeries.slice(-10)}
        />
      </section>

      <Card>
        <CardBody>
          <Suspense fallback={<div className="h-64" />}>
            <RevenueChart
              series={series}
              granularity={config.granularity}
              activeRange={activeRange}
            />
          </Suspense>
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Best sellers · last 30 days</CardTitle>
          </CardHeader>
          <CardBody>
            {bestSellers.length === 0 ? (
              <EmptyState title="No sales in the last 30 days" />
            ) : (
              <BarList
                items={bestSellers.map((product) => ({
                  id: product.productId,
                  label: product.title,
                  sublabel: `${product.unitsSold} sold · ${product.velocityPerDay}/day`,
                  value: product.revenueMinor,
                  display: formatMoney(product.revenueMinor),
                }))}
              />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Revenue by category · last 30 days</CardTitle>
          </CardHeader>
          <CardBody>
            {categories.length === 0 ? (
              <EmptyState title="No category sales yet" />
            ) : (
              <BarList
                items={categories.map((category) => ({
                  id: category.category,
                  label: category.category,
                  sublabel: `${category.units} units`,
                  value: category.revenueMinor,
                  display: formatMoney(category.revenueMinor),
                }))}
              />
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex items-center justify-between gap-3">
          <CardTitle>Inventory alerts</CardTitle>
          <span className="text-xs text-muted-foreground">
            {alerts.filter((a) => a.severity === "stockout").length} out of stock ·{" "}
            {alerts.length} need attention
          </span>
        </CardHeader>
        <CardBody className="px-0 py-0">
          {alerts.length === 0 ? (
            <div className="p-5">
              <EmptyState title="Every variant is above its low-stock threshold" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-5 py-2 font-medium">Product</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 text-right font-medium">Available</th>
                    <th className="px-3 py-2 text-right font-medium">Selling</th>
                    <th className="px-3 py-2 text-right font-medium">Days left</th>
                    <th className="px-5 py-2 text-right font-medium">30-day revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.slice(0, 10).map((alert) => (
                    <tr key={alert.variantId} className="border-b border-border last:border-0">
                      <td className="px-5 py-2.5">
                        <span className="block truncate">{alert.title}</span>
                        <span className="text-xs text-subtle">
                          {Object.entries(alert.attributes)
                            .map(([k, v]) => `${k} ${v}`)
                            .join(" · ")}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={SEVERITY[alert.severity].tone}>
                          {SEVERITY[alert.severity].label}
                        </Badge>
                      </td>
                      <td className="tabular px-3 py-2.5 text-right">{alert.available}</td>
                      <td className="tabular px-3 py-2.5 text-right text-muted-foreground">
                        {alert.velocityPerDay}/day
                      </td>
                      <td className="tabular px-3 py-2.5 text-right">
                        {alert.daysOfCoverAtCurrentRate === null
                          ? "—"
                          : `${alert.daysOfCoverAtCurrentRate}d`}
                      </td>
                      <td className="tabular px-5 py-2.5 text-right text-muted-foreground">
                        {formatMoney(alert.revenueAtRiskMinor)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {declining.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Losing momentum · last 14 days vs the 14 before</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="space-y-2">
              {declining.map((trend) => (
                <li key={trend.productId} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">{trend.title}</span>
                  <span className="tabular shrink-0 text-danger">
                    ▼ {Math.abs(trend.changeBp / 100).toFixed(0)}%
                    <span className="ml-1.5 text-xs text-subtle">
                      {trend.priorUnits} → {trend.recentUnits} units
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
