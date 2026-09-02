import type { Action } from "@/lib/agent-types";
import { formatMoney } from "@/lib/money";
import {
  getBestSellers,
  getDemandTrends,
  getStockAlerts,
  type StockAlert,
} from "@/server/analytics/merchant";
import { db } from "@/db";
import { sql } from "drizzle-orm";

/**
 * Insight detection — deterministic, evidence-first.
 *
 * No LLM runs here. Each detector reads the merchant's real numbers and emits a
 * finding with the evidence attached, so a recommendation can always be traced
 * back to the figures that produced it. The model's only job, later, is to
 * phrase these findings in plain language.
 */

export type DetectedInsight = {
  kind:
    | "restock"
    | "stockout_risk"
    | "overstock"
    | "price_adjustment"
    | "promotion"
    | "availability"
    | "demand_trend"
    | "catalog_quality";
  severity: "info" | "warning" | "critical";
  title: string;
  /** Deterministic explanation; the LLM may rewrite the wording, never the facts. */
  baseExplanation: string;
  evidence: Record<string, unknown>;
  recommendation: Action;
  projectedImpact?: {
    metric: string;
    valueMinor?: number;
    value?: number;
    confidence: "low" | "medium" | "high";
    basis: string;
  };
  dedupeKey: string;
};

/** Cover in days at the current rate, used to rank urgency. */
function coverDays(alert: StockAlert): number | null {
  return alert.daysOfCoverAtCurrentRate;
}

/** Out of stock while still selling — the most expensive failure a shop has. */
function detectStockouts(alerts: StockAlert[]): DetectedInsight[] {
  return alerts
    .filter((a) => a.available === 0 && a.velocityPerDay > 0)
    .map((alert) => {
      const monthlyUnits = Math.ceil(alert.velocityPerDay * 30);
      const monthlyRevenue = Math.round(alert.revenueAtRiskMinor);
      return {
        kind: "restock" as const,
        severity: "critical" as const,
        title: `${alert.title} is out of stock and still selling`,
        baseExplanation:
          `${alert.title} (${describeVariant(alert)}) has 0 units available but sold at ` +
          `${alert.velocityPerDay} units/day over the last 30 days, generating ` +
          `${formatMoney(alert.revenueAtRiskMinor)}. Every day it stays out of stock forgoes ` +
          `roughly ${formatMoney(Math.round(alert.revenueAtRiskMinor / 30))} of sales.`,
        evidence: {
          sku: alert.sku,
          available: 0,
          velocityPerDay: alert.velocityPerDay,
          revenueLast30DaysMinor: alert.revenueAtRiskMinor,
          suggestedUnits: monthlyUnits,
        },
        recommendation: {
          type: "merchant_restock",
          params: { variantId: alert.variantId, units: monthlyUnits, sku: alert.sku },
        },
        projectedImpact: {
          metric: "recovered monthly revenue",
          valueMinor: monthlyRevenue,
          confidence: "high" as const,
          basis: "30 days of observed sales at the current rate",
        },
        dedupeKey: `restock:${alert.variantId}`,
      };
    });
}

/** Still in stock, but the runway is short enough to act on now. */
function detectStockoutRisk(alerts: StockAlert[]): DetectedInsight[] {
  return alerts
    .filter((a) => a.available > 0 && a.velocityPerDay > 0)
    .filter((a) => {
      const cover = coverDays(a);
      return cover !== null && cover <= 14;
    })
    .map((alert) => {
      const cover = coverDays(alert)!;
      const monthlyUnits = Math.ceil(alert.velocityPerDay * 30);
      return {
        kind: "stockout_risk" as const,
        severity: (cover <= 7 ? "critical" : "warning") as "critical" | "warning",
        title: `${alert.title} runs out in about ${cover} days`,
        baseExplanation:
          `${alert.title} (${describeVariant(alert)}) has ${alert.available} units left and is ` +
          `selling ${alert.velocityPerDay} per day — roughly ${cover} days of cover. ` +
          `It earned ${formatMoney(alert.revenueAtRiskMinor)} over the last 30 days, so a ` +
          `stockout would put that run rate at risk.`,
        evidence: {
          sku: alert.sku,
          available: alert.available,
          velocityPerDay: alert.velocityPerDay,
          daysOfCover: cover,
          revenueLast30DaysMinor: alert.revenueAtRiskMinor,
          suggestedUnits: monthlyUnits,
        },
        recommendation: {
          type: "merchant_restock",
          params: { variantId: alert.variantId, units: monthlyUnits, sku: alert.sku },
        },
        projectedImpact: {
          metric: "protected monthly revenue",
          valueMinor: alert.revenueAtRiskMinor,
          confidence: "medium" as const,
          basis: "current sales rate projected over 30 days",
        },
        dedupeKey: `stockout_risk:${alert.variantId}`,
      };
    });
}

/** Capital sitting still: plenty of stock, no movement. */
async function detectOverstock(merchantId: string): Promise<DetectedInsight[]> {
  const rows = (await db.execute<Record<string, string>>(sql`
    WITH sold AS (
      SELECT oi.variant_id, SUM(oi.quantity) AS units
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.merchant_id = ${merchantId}
        AND o.state IN ('paid','fulfilled')
        AND o.created_at >= now() - interval '60 days'
      GROUP BY oi.variant_id
    )
    SELECT v.id AS variant_id, p.title, v.sku, v.attributes, v.price_minor,
           GREATEST(i.quantity - i.reserved, 0) AS available,
           COALESCE(s.units, 0) AS units_sold
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    JOIN inventory i ON i.variant_id = v.id
    LEFT JOIN sold s ON s.variant_id = v.id
    WHERE p.merchant_id = ${merchantId}
      AND p.status = 'active' AND v.active = true
      AND GREATEST(i.quantity - i.reserved, 0) >= 25
      AND COALESCE(s.units, 0) <= 1
    ORDER BY available DESC
    LIMIT 5
  `)) as unknown as Record<string, string>[];

  return rows.map((row) => {
    const available = Number(row.available);
    const priceMinor = Number(row.price_minor);
    const tiedUp = available * priceMinor;
    return {
      kind: "overstock" as const,
      severity: "info" as const,
      title: `${row.title} is overstocked and barely moving`,
      baseExplanation:
        `${row.title} (${row.sku}) has ${available} units in stock but sold only ` +
        `${row.units_sold} in the last 60 days. That is about ${formatMoney(tiedUp)} of ` +
        `inventory tied up. A time-boxed discount would convert some of it back into cash.`,
      evidence: {
        sku: row.sku,
        available,
        unitsSoldLast60Days: Number(row.units_sold),
        capitalTiedUpMinor: tiedUp,
        currentPriceMinor: priceMinor,
      },
      recommendation: {
        type: "merchant_discount",
        params: { variantId: row.variant_id, bp: 1000, title: `10% off ${row.title}` },
      },
      projectedImpact: {
        metric: "capital freed if half the stock clears",
        valueMinor: Math.round(tiedUp * 0.45),
        confidence: "low" as const,
        basis: "assumes a 10% discount clears half the units; not observed",
      },
      dedupeKey: `overstock:${row.variant_id}`,
    };
  });
}

/** Sharp fall in units sold between two equal windows. */
async function detectDemandDrops(merchantId: string): Promise<DetectedInsight[]> {
  const trends = await getDemandTrends(merchantId, 14);
  return trends
    .filter((t) => t.changeBp <= -3000 && t.priorUnits >= 3)
    .slice(0, 4)
    .map((trend) => ({
      kind: "demand_trend" as const,
      severity: "warning" as const,
      title: `${trend.title} sales fell ${Math.abs(trend.changeBp / 100).toFixed(0)}%`,
      baseExplanation:
        `${trend.title} sold ${trend.recentUnits} units in the last 14 days versus ` +
        `${trend.priorUnits} in the 14 before — a ${Math.abs(trend.changeBp / 100).toFixed(0)}% drop. ` +
        `This is a demand signal, not a stock problem; a promotion or price review is the usual response.`,
      evidence: {
        sku: trend.sku,
        recentUnits: trend.recentUnits,
        priorUnits: trend.priorUnits,
        changeBp: trend.changeBp,
        windowDays: 14,
      },
      recommendation: {
        type: "merchant_discount",
        params: { productId: trend.productId, bp: 500, title: `5% off ${trend.title}` },
      },
      projectedImpact: {
        metric: "units recovered per 14 days",
        value: Math.max(trend.priorUnits - trend.recentUnits, 0),
        confidence: "low" as const,
        basis: "returning to the previous window's rate; demand causes are not measured here",
      },
      dedupeKey: `demand_trend:${trend.productId}`,
    }));
}

/**
 * Listings too thin for an AI buyer to evaluate.
 *
 * Specific to this marketplace: agents match on structured attributes, so a
 * product with no description or attributes is effectively invisible to them
 * even though it looks fine to a human browsing.
 */
async function detectCatalogQuality(merchantId: string): Promise<DetectedInsight[]> {
  const rows = (await db.execute<Record<string, string>>(sql`
    SELECT p.id, p.title, p.category,
           length(p.description) AS description_length,
           (SELECT count(*) FROM jsonb_object_keys(p.attributes)) AS attribute_count
    FROM products p
    WHERE p.merchant_id = ${merchantId}
      AND p.status = 'active'
      AND (
        length(p.description) < 80
        OR (SELECT count(*) FROM jsonb_object_keys(p.attributes)) < 2
      )
    ORDER BY length(p.description) ASC
    LIMIT 5
  `)) as unknown as Record<string, string>[];

  return rows.map((row) => ({
    kind: "catalog_quality" as const,
    severity: "info" as const,
    title: `${row.title} is hard for AI buyers to evaluate`,
    baseExplanation:
      `${row.title} has a short description and few structured attributes. AI shopping ` +
      `agents filter on structured facts, so a thin listing is effectively invisible to ` +
      `them even though it reads fine to a person. Adding attributes improves how often ` +
      `this product is recalled and ranked.`,
    evidence: {
      productId: row.id,
      descriptionLength: Number(row.description_length ?? 0),
      attributeCount: Number(row.attribute_count ?? 0),
      category: row.category,
    },
    recommendation: { type: "merchant_enrich_listing", params: { productId: row.id } },
    projectedImpact: {
      metric: "improved agent discoverability",
      confidence: "low" as const,
      basis: "structured attributes drive retrieval filters and ranking",
    },
    dedupeKey: `catalog_quality:${row.id}`,
  }));
}

/**
 * Dead listings: out of stock long enough that nobody is buying them, yet still
 * marked for sale.
 *
 * These are worse than invisible — an agent ranks them, a shopper picks one, and
 * checkout fails. Withdrawing them is an availability change, which is why it is
 * recommended rather than applied: only the merchant knows whether stock is
 * coming back.
 */
async function detectStaleUnavailable(merchantId: string): Promise<DetectedInsight[]> {
  const rows = (await db.execute<Record<string, string>>(sql`
    WITH recent AS (
      SELECT oi.variant_id, SUM(oi.quantity) AS units
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.merchant_id = ${merchantId}
        AND o.state IN ('paid','fulfilled')
        AND o.created_at >= now() - interval '30 days'
      GROUP BY oi.variant_id
    )
    SELECT v.id AS variant_id, p.id AS product_id, p.title, v.sku, v.attributes,
           i.restock_eta
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    JOIN inventory i ON i.variant_id = v.id
    LEFT JOIN recent r ON r.variant_id = v.id
    WHERE p.merchant_id = ${merchantId}
      AND p.status = 'active'
      AND v.active = true
      AND GREATEST(i.quantity - i.reserved, 0) = 0
      AND COALESCE(r.units, 0) = 0
      AND i.restock_eta IS NULL
    LIMIT 5
  `)) as unknown as Record<string, string>[];

  return rows.map((row) => {
    const attributes = (row.attributes as unknown as Record<string, string>) ?? {};
    const variantLabel = Object.entries(attributes).map(([k, v]) => `${k} ${v}`).join(", ") || row.sku;
    return {
      kind: "availability" as const,
      severity: "warning" as const,
      title: `${row.title} is unbuyable but still listed`,
      baseExplanation:
        `${row.title} (${variantLabel}) has no stock, no restock date and no sales in 30 days, yet it is ` +
        `still marked for sale. AI agents will keep ranking it and shoppers will hit a dead end at ` +
        `checkout. Withdraw it from sale until stock returns, or set a restock date so the agent ` +
        `treats it as temporarily out rather than abandoned.`,
      evidence: {
        sku: row.sku,
        available: 0,
        unitsSoldLast30Days: 0,
        restockEta: null,
        stillListed: true,
      },
      recommendation: {
        type: "merchant_availability",
        params: { variantId: row.variant_id, sku: row.sku, enable: false },
      },
      projectedImpact: {
        metric: "failed checkouts avoided",
        confidence: "medium" as const,
        basis: "removes a listing that cannot be fulfilled from agent search results",
      },
      dedupeKey: `availability:${row.variant_id}`,
    };
  });
}

function describeVariant(alert: StockAlert): string {
  const attrs = Object.entries(alert.attributes)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return attrs || alert.sku;
}

/** Runs every detector and returns findings ranked by urgency. */
export async function detectInsights(merchantId: string): Promise<DetectedInsight[]> {
  const alerts = await getStockAlerts(merchantId, 30);
  const [overstock, demand, quality, stale] = await Promise.all([
    detectOverstock(merchantId),
    detectDemandDrops(merchantId),
    detectCatalogQuality(merchantId),
    detectStaleUnavailable(merchantId),
  ]);

  const severityRank = { critical: 0, warning: 1, info: 2 };
  return [
    ...detectStockouts(alerts),
    ...detectStockoutRisk(alerts),
    ...stale,
    ...demand,
    ...overstock,
    ...quality,
  ].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
}

export { getBestSellers };
