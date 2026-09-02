import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { merchants } from "@/db/schema";
import { formatMoney } from "@/lib/money";
import {
  getBestSellers,
  getCategoryBreakdown,
  getMerchantSummary,
} from "@/server/analytics/merchant";
import { challengeBody, resourceUrl, verifyPayment } from "@/server/protocols/x402/facilitator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A paid, machine-to-machine API endpoint.
 *
 * Aggregate market data is the natural thing to meter: it is valuable to other
 * agents, cheap to serve, and has no human buyer to put through a checkout.
 * Unpaid requests get 402 plus the terms; a signed retry gets the data.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ merchant: string }> },
) {
  const { merchant: slug } = await params;
  const path = `/api/x402/insights/${slug}`;
  const resource = resourceUrl(path);
  const description = `Aggregate sales insights for ${slug}: revenue, best sellers and category mix.`;

  const [merchant] = await db.select().from(merchants).where(eq(merchants.slug, slug)).limit(1);
  if (!merchant) return NextResponse.json({ error: "Unknown merchant" }, { status: 404 });

  const verification = verifyPayment(request.headers.get("x-payment"), resource);

  if (!verification.valid) {
    return NextResponse.json(
      { ...challengeBody(resource, description), reason: verification.reason },
      {
        status: 402,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE",
        },
      },
    );
  }

  const [summary, bestSellers, categories] = await Promise.all([
    getMerchantSummary(merchant.id),
    getBestSellers(merchant.id, 30, 5),
    getCategoryBreakdown(merchant.id, 30),
  ]);

  return NextResponse.json(
    {
      merchant: { slug: merchant.slug, name: merchant.name },
      period: "last 30 days",
      revenue: {
        month: formatMoney(summary.revenue.monthMinor),
        year: formatMoney(summary.revenue.yearMinor),
        average_order_value: formatMoney(summary.averageOrderValueMinor),
        month_over_month_change_pct: summary.revenueChangeBp / 100,
      },
      orders: summary.orders,
      agent_order_share_pct: summary.agentOrderShareBp / 100,
      best_sellers: bestSellers.map((b) => ({
        title: b.title,
        units_sold: b.unitsSold,
        revenue: formatMoney(b.revenueMinor),
        velocity_per_day: b.velocityPerDay,
      })),
      category_mix: categories.map((c) => ({
        category: c.category,
        revenue: formatMoney(c.revenueMinor),
        units: c.units,
      })),
      paid_by: verification.payer,
      amount_paid_atomic: verification.amount,
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        // Settlement receipt, per x402.
        "X-PAYMENT-RESPONSE": Buffer.from(
          JSON.stringify({ success: true, payer: verification.payer, network: "mock-facilitator" }),
        ).toString("base64"),
      },
    },
  );
}
