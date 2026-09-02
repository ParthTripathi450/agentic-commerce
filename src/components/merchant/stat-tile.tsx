import { cn } from "@/lib/utils";
import { Sparkline } from "./sparkline";

/**
 * A headline figure with its trend.
 *
 * A stat tile, not a one-bar chart: for a current value plus its change, the
 * number IS the visualisation. The delta carries an arrow and the words "up" or
 * "down" as well as colour, so direction never depends on colour alone.
 */
export function StatTile({
  label,
  value,
  hint,
  deltaBp,
  deltaLabel = "vs last month",
  series,
  hero,
}: {
  label: string;
  value: string;
  hint?: string;
  deltaBp?: number;
  deltaLabel?: string;
  series?: number[];
  hero?: boolean;
}) {
  const direction =
    deltaBp === undefined ? "flat" : deltaBp > 0 ? "up" : deltaBp < 0 ? "down" : "flat";

  return (
    <div className="rounded-xl border border-border bg-card px-5 py-4 shadow-xs">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>

      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p
            className={cn(
              "tabular font-semibold tracking-tight",
              hero ? "text-4xl" : "text-3xl",
            )}
          >
            {value}
          </p>

          <div className="mt-2 flex flex-wrap items-baseline gap-1.5 text-xs">
            {deltaBp !== undefined ? (
              <span
                className={cn(
                  "inline-flex items-center gap-1 font-medium",
                  direction === "up" && "text-success",
                  direction === "down" && "text-danger",
                  direction === "flat" && "text-muted-foreground",
                )}
              >
                <span aria-hidden>{direction === "up" ? "↑" : direction === "down" ? "↓" : "→"}</span>
                {Math.abs(deltaBp / 100).toFixed(0)}%
                <span className="sr-only">{direction === "up" ? "up" : direction === "down" ? "down" : "flat"}</span>
              </span>
            ) : null}
            <span className="text-muted-foreground">{hint ?? deltaLabel}</span>
          </div>
        </div>

        {series && series.length > 1 ? (
          <Sparkline values={series} direction={direction} className="shrink-0" />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Horizontal magnitude bars.
 *
 * Plain HTML rather than a chart library: with a direct value label on every row
 * this reads as a ranked list, and a single hue is correct because the bars
 * encode magnitude, not identity.
 */
export function BarList({
  items,
}: {
  items: Array<{ id: string; label: string; sublabel?: string; value: number; display: string }>;
}) {
  const max = Math.max(...items.map((i) => i.value), 1);

  return (
    <ol className="space-y-3">
      {items.map((item) => (
        <li key={item.id}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-sm">{item.label}</span>
            <span className="tabular shrink-0 text-sm font-medium">{item.display}</span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.max((item.value / max) * 100, 2)}%` }}
              />
            </div>
            {item.sublabel ? (
              <span className="shrink-0 text-xs text-subtle">{item.sublabel}</span>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
