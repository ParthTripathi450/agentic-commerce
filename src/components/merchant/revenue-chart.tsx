"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatMoney } from "@/lib/money";
import type { RevenuePoint } from "@/server/analytics/merchant";

/**
 * Revenue over time.
 *
 * One series, so it is a single-hue area with no legend — the heading names it.
 * Colour is the app accent used sequentially rather than a categorical palette,
 * because there is no identity to distinguish, only magnitude over time.
 */

const RANGES = [
  { key: "30d", label: "30 days", granularity: "day" as const, periods: 30 },
  { key: "12m", label: "12 months", granularity: "month" as const, periods: 12 },
  { key: "5y", label: "5 years", granularity: "year" as const, periods: 5 },
];

export type RangeKey = (typeof RANGES)[number]["key"];

function formatPeriod(period: string, granularity: "day" | "month" | "year") {
  const date = new Date(period);
  if (granularity === "year") return String(date.getUTCFullYear());
  if (granularity === "month")
    return date.toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" });
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function RevenueChart({
  series,
  granularity,
  activeRange,
}: {
  series: RevenuePoint[];
  granularity: "day" | "month" | "year";
  activeRange: RangeKey;
}) {
  // Range lives in the URL so the server re-queries rather than shipping every
  // period to the client and filtering there.
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const active = activeRange;
  const data = series.map((p) => ({
    ...p,
    label: formatPeriod(p.period, granularity),
    revenue: p.revenueMinor / 100,
  }));
  const total = series.reduce((sum, p) => sum + p.revenueMinor, 0);

  return (
    <div>
      {/* Filters sit in one row above the chart. */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Revenue</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {formatMoney(total)} across the selected period
          </p>
        </div>
        <div className="flex gap-1" role="group" aria-label="Time range">
          {RANGES.map((range) => (
            <button
              key={range.key}
              type="button"
              aria-pressed={active === range.key}
              onClick={() => {
                const next = new URLSearchParams(params.toString());
                next.set("range", range.key);
                startTransition(() => router.replace(`?${next.toString()}`, { scroll: false }));
              }}
              className={
                active === range.key
                  ? "rounded-md border border-primary bg-primary-soft px-2.5 py-1 text-xs font-medium text-primary"
                  : "rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-surface-2"
              }
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      <div className="h-64 w-full transition-opacity" aria-busy={pending} style={{ opacity: pending ? 0.6 : 1 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
            {/* Series colour is --primary. NOT --accent: shadcn defines that as a
                pale background tint, which rendered the line almost invisible. */}
            <defs>
              <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.22} />
                <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.01} />
              </linearGradient>
            </defs>
            {/* Recessive grid: horizontal only, so it guides without competing. */}
            <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={{ stroke: "var(--border)" }}
              tick={{ fill: "var(--text-subtle)", fontSize: 11 }}
              minTickGap={24}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={{ fill: "var(--text-subtle)", fontSize: 11 }}
              width={54}
              tickFormatter={(value: number) =>
                value >= 100000
                  ? `₹${(value / 100000).toFixed(1)}L`
                  : value >= 1000
                    ? `₹${Math.round(value / 1000)}k`
                    : `₹${value}`
              }
            />
            <Tooltip
              cursor={{ stroke: "var(--primary)", strokeWidth: 1, strokeDasharray: "3 3" }}
              contentStyle={{
                background: "var(--surface)",
                border: "1px solid var(--border-strong)",
                borderRadius: 8,
                fontSize: 12,
                color: "var(--text)",
                boxShadow: "var(--shadow)",
              }}
              labelStyle={{ color: "var(--text-muted-foreground)", marginBottom: 2 }}
              formatter={((value: unknown, _name: unknown, entry: unknown) => {
                const revenue = Number(value ?? 0);
                const orders =
                  (entry as { payload?: { orders?: number } } | undefined)?.payload?.orders ?? 0;
                return [
                  `${formatMoney(Math.round(revenue * 100))} · ${orders} order${orders === 1 ? "" : "s"}`,
                  "Revenue",
                ];
              }) as never}
            />
            <Area
              type="monotone"
              dataKey="revenue"
              stroke="var(--primary)"
              strokeWidth={2.5}
              fill="url(#revenueFill)"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
              name="Revenue"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
