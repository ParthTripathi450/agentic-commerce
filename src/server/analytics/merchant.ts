import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Merchant analytics.
 *
 * All aggregation happens in Postgres rather than in JavaScript: these queries
 * run on every dashboard load, and pulling 90 days of orders into memory to sum
 * them would be both slower and wrong under concurrent writes.
 *
 * Revenue counts only orders that were actually paid — `paid` and `fulfilled`.
 * Pending, cancelled and failed orders are excluded, so the number on the
 * dashboard is money genuinely received.
 */

const PAID_STATES = sql`('paid','fulfilled')`;

export type RevenuePoint = { period: string; revenueMinor: number; orders: number };

export type MerchantSummary = {
  revenue: { todayMinor: number; monthMinor: number; yearMinor: number; allTimeMinor: number };
  orders: { today: number; month: number; year: number; allTime: number };
  averageOrderValueMinor: number;
  /** Share of paid orders placed by an AI agent rather than a human. */
  agentOrderShareBp: number;
  /** Month-over-month revenue change, in basis points. */
  revenueChangeBp: number;
  pendingOrders: number;
  failedPayments: number;
};

export async function getMerchantSummary(merchantId: string): Promise<MerchantSummary> {
  const [row] = (await db.execute<Record<string, string>>(sql`
    WITH paid AS (
      SELECT created_at,
             (totals->>'totalMinor')::bigint AS total,
             placed_by_agent
      FROM orders
      WHERE merchant_id = ${merchantId} AND state IN ${PAID_STATES}
    )
    SELECT
      COALESCE(SUM(total) FILTER (WHERE created_at >= date_trunc('day', now())), 0)   AS revenue_today,
      COALESCE(SUM(total) FILTER (WHERE created_at >= date_trunc('month', now())), 0) AS revenue_month,
      COALESCE(SUM(total) FILTER (WHERE created_at >= date_trunc('year', now())), 0)  AS revenue_year,
      COALESCE(SUM(total), 0) AS revenue_all,
      COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now()))   AS orders_today,
      COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now())) AS orders_month,
      COUNT(*) FILTER (WHERE created_at >= date_trunc('year', now()))  AS orders_year,
      COUNT(*) AS orders_all,
      COALESCE(AVG(total), 0) AS aov,
      COUNT(*) FILTER (WHERE placed_by_agent IS NOT NULL) AS agent_orders,
      -- Same number of days into the previous month, so a month that is one
      -- day old is not compared against a full one.
      COALESCE(SUM(total) FILTER (
        WHERE created_at >= date_trunc('month', now() - interval '1 month')
          AND created_at <  date_trunc('month', now() - interval '1 month')
                            + (now() - date_trunc('month', now()))
      ), 0) AS revenue_prev_month_to_date
    FROM paid
  `)) as unknown as Record<string, string>[];

  const [extra] = (await db.execute<Record<string, string>>(sql`
    SELECT
      COUNT(*) FILTER (WHERE state = 'pending_payment') AS pending,
      COUNT(*) FILTER (WHERE state = 'payment_failed')  AS failed
    FROM orders WHERE merchant_id = ${merchantId}
  `)) as unknown as Record<string, string>[];

  const ordersAll = Number(row.orders_all);
  const prevMonth = Number(row.revenue_prev_month_to_date);
  const thisMonth = Number(row.revenue_month);

  return {
    revenue: {
      todayMinor: Number(row.revenue_today),
      monthMinor: thisMonth,
      yearMinor: Number(row.revenue_year),
      allTimeMinor: Number(row.revenue_all),
    },
    orders: {
      today: Number(row.orders_today),
      month: Number(row.orders_month),
      year: Number(row.orders_year),
      allTime: ordersAll,
    },
    averageOrderValueMinor: Math.round(Number(row.aov)),
    agentOrderShareBp: ordersAll > 0 ? Math.round((Number(row.agent_orders) / ordersAll) * 10_000) : 0,
    // No prior month to compare against reads as "no change", not infinite growth.
    revenueChangeBp: prevMonth > 0 ? Math.round(((thisMonth - prevMonth) / prevMonth) * 10_000) : 0,
    pendingOrders: Number(extra.pending),
    failedPayments: Number(extra.failed),
  };
}

/** Revenue time series. Gaps are filled with zeroes so charts do not mislead. */
export async function getRevenueSeries(
  merchantId: string,
  granularity: "day" | "month" | "year" = "day",
  periods = 30,
): Promise<RevenuePoint[]> {
  const unit = granularity;
  const rows = (await db.execute<Record<string, string>>(sql`
    WITH series AS (
      SELECT generate_series(
        date_trunc(${unit}, now()) - (${periods - 1} || ' ' || ${unit})::interval,
        date_trunc(${unit}, now()),
        ('1 ' || ${unit})::interval
      ) AS period
    ),
    totals AS (
      SELECT date_trunc(${unit}, created_at) AS period,
             SUM((totals->>'totalMinor')::bigint) AS revenue,
             COUNT(*) AS orders
      FROM orders
      WHERE merchant_id = ${merchantId} AND state IN ${PAID_STATES}
      GROUP BY 1
    )
    SELECT to_char(s.period, 'YYYY-MM-DD') AS period,
           COALESCE(t.revenue, 0) AS revenue,
           COALESCE(t.orders, 0) AS orders
    FROM series s
    LEFT JOIN totals t ON t.period = s.period
    ORDER BY s.period
  `)) as unknown as Record<string, string>[];

  return rows.map((r) => ({
    period: r.period,
    revenueMinor: Number(r.revenue),
    orders: Number(r.orders),
  }));
}

export type BestSeller = {
  productId: string;
  title: string;
  sku: string;
  unitsSold: number;
  revenueMinor: number;
  /** Units sold per day over the window — drives restock urgency. */
  velocityPerDay: number;
  availableQuantity: number;
};

export async function getBestSellers(
  merchantId: string,
  days = 30,
  limit = 8,
): Promise<BestSeller[]> {
  const rows = (await db.execute<Record<string, string>>(sql`
    -- Aggregated per PRODUCT, summing across its variants: a shoe selling in
    -- five sizes is one best-seller, not five separate entries.
    WITH stock AS (
      SELECT v.product_id, SUM(GREATEST(i.quantity - i.reserved, 0)) AS available
      FROM product_variants v
      JOIN inventory i ON i.variant_id = v.id
      GROUP BY v.product_id
    )
    SELECT
      p.id AS product_id, p.title,
      COUNT(DISTINCT oi.sku_snapshot) || ' variants' AS sku,
      SUM(oi.quantity) AS units,
      SUM(oi.quantity * oi.unit_price_minor) AS revenue,
      COALESCE(MAX(stock.available), 0) AS available
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN product_variants v ON v.id = oi.variant_id
    JOIN products p ON p.id = v.product_id
    LEFT JOIN stock ON stock.product_id = p.id
    WHERE o.merchant_id = ${merchantId}
      AND o.state IN ${PAID_STATES}
      AND o.created_at >= now() - (${days} || ' days')::interval
    GROUP BY p.id, p.title
    ORDER BY units DESC
    LIMIT ${limit}
  `)) as unknown as Record<string, string>[];

  return rows.map((r) => ({
    productId: r.product_id,
    title: r.title,
    sku: r.sku,
    unitsSold: Number(r.units),
    revenueMinor: Number(r.revenue),
    velocityPerDay: Number((Number(r.units) / days).toFixed(2)),
    availableQuantity: Number(r.available),
  }));
}

export type StockAlert = {
  variantId: string;
  productId: string;
  title: string;
  sku: string;
  attributes: Record<string, string>;
  available: number;
  threshold: number;
  velocityPerDay: number;
  /** Days until stockout at the current rate; null when nothing is selling. */
  daysOfCoverAtCurrentRate: number | null;
  severity: "stockout" | "critical" | "low";
  revenueAtRiskMinor: number;
};

/**
 * Stock alerts ranked by urgency.
 *
 * Severity blends stock level with sales velocity: 4 units of something selling
 * 3/day is more urgent than 4 units of something selling one a month, and a
 * plain threshold cannot tell those apart.
 */
export async function getStockAlerts(merchantId: string, days = 30): Promise<StockAlert[]> {
  const rows = (await db.execute<Record<string, string>>(sql`
    WITH sold AS (
      SELECT oi.variant_id, SUM(oi.quantity) AS units,
             SUM(oi.quantity * oi.unit_price_minor) AS revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.merchant_id = ${merchantId}
        AND o.state IN ${PAID_STATES}
        AND o.created_at >= now() - (${days} || ' days')::interval
      GROUP BY oi.variant_id
    )
    SELECT v.id AS variant_id, p.id AS product_id, p.title, v.sku, v.attributes,
           GREATEST(i.quantity - i.reserved, 0) AS available,
           i.low_stock_threshold AS threshold,
           COALESCE(s.units, 0) AS units_sold,
           COALESCE(s.revenue, 0) AS revenue
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    JOIN inventory i ON i.variant_id = v.id
    LEFT JOIN sold s ON s.variant_id = v.id
    WHERE p.merchant_id = ${merchantId}
      AND p.status = 'active' AND v.active = true
      AND GREATEST(i.quantity - i.reserved, 0) <= i.low_stock_threshold
    ORDER BY available ASC, units_sold DESC
  `)) as unknown as Record<string, string>[];

  return rows.map((r) => {
    const available = Number(r.available);
    const velocity = Number(r.units_sold) / days;
    const cover = velocity > 0 ? Number((available / velocity).toFixed(1)) : null;
    const severity: StockAlert["severity"] =
      available === 0 ? "stockout" : cover !== null && cover <= 7 ? "critical" : "low";

    return {
      variantId: r.variant_id,
      productId: r.product_id,
      title: r.title,
      sku: r.sku,
      attributes: (r.attributes as unknown as Record<string, string>) ?? {},
      available,
      threshold: Number(r.threshold),
      velocityPerDay: Number(velocity.toFixed(2)),
      daysOfCoverAtCurrentRate: cover,
      severity,
      // What 30 days of this product's sales are worth, if it goes to zero.
      revenueAtRiskMinor: Math.round(Number(r.revenue)),
    };
  });
}

export type CategoryBreakdown = { category: string; revenueMinor: number; units: number };

export async function getCategoryBreakdown(
  merchantId: string,
  days = 30,
): Promise<CategoryBreakdown[]> {
  const rows = (await db.execute<Record<string, string>>(sql`
    SELECT p.category,
           SUM(oi.quantity * oi.unit_price_minor) AS revenue,
           SUM(oi.quantity) AS units
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN product_variants v ON v.id = oi.variant_id
    JOIN products p ON p.id = v.product_id
    WHERE o.merchant_id = ${merchantId}
      AND o.state IN ${PAID_STATES}
      AND o.created_at >= now() - (${days} || ' days')::interval
    GROUP BY p.category
    ORDER BY revenue DESC
  `)) as unknown as Record<string, string>[];

  return rows.map((r) => ({
    category: r.category,
    revenueMinor: Number(r.revenue),
    units: Number(r.units),
  }));
}

/** Products losing momentum: compares the recent window with the one before it. */
export async function getDemandTrends(merchantId: string, days = 14) {
  const rows = (await db.execute<Record<string, string>>(sql`
    WITH windows AS (
      SELECT oi.variant_id,
             SUM(oi.quantity) FILTER (WHERE o.created_at >= now() - (${days} || ' days')::interval) AS recent,
             SUM(oi.quantity) FILTER (
               WHERE o.created_at >= now() - (${days * 2} || ' days')::interval
                 AND o.created_at <  now() - (${days} || ' days')::interval
             ) AS prior
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.merchant_id = ${merchantId} AND o.state IN ${PAID_STATES}
      GROUP BY oi.variant_id
    )
    SELECT p.id AS product_id, p.title, MIN(v.sku) AS sku,
           SUM(COALESCE(w.recent, 0)) AS recent, SUM(COALESCE(w.prior, 0)) AS prior
    FROM windows w
    JOIN product_variants v ON v.id = w.variant_id
    JOIN products p ON p.id = v.product_id
    GROUP BY p.id, p.title
    HAVING SUM(COALESCE(w.prior, 0)) > 0 OR SUM(COALESCE(w.recent, 0)) > 0
  `)) as unknown as Record<string, string>[];

  return rows
    .map((r) => {
      const recent = Number(r.recent);
      const prior = Number(r.prior);
      return {
        productId: r.product_id,
        title: r.title,
        sku: r.sku,
        recentUnits: recent,
        priorUnits: prior,
        changeBp: prior > 0 ? Math.round(((recent - prior) / prior) * 10_000) : 10_000,
      };
    })
    .sort((a, b) => a.changeBp - b.changeBp);
}
