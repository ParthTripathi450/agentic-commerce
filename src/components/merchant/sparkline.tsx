import { cn } from "@/lib/utils";

/**
 * Inline sparkline.
 *
 * Hand-drawn SVG rather than a chart library: these render four to a row on
 * every dashboard load, and pulling in Recharts for a 60-pixel trend line would
 * cost more than the whole rest of the page.
 *
 * No axes, no labels — a sparkline shows shape, and the exact figure is already
 * stated beside it in text.
 */
export function Sparkline({
  values,
  direction = "up",
  className,
  width = 120,
  height = 44,
}: {
  values: number[];
  direction?: "up" | "down" | "flat";
  className?: string;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return <div className={cn("h-11", className)} aria-hidden />;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const pad = 4;
  const usable = height - pad * 2;

  const points = values.map((value, index) => {
    const x = index * step;
    const y = pad + usable - ((value - min) / span) * usable;
    return [x, y] as const;
  });

  /** Catmull-Rom style smoothing, so the line reads as a trend not a zigzag. */
  const path = points
    .map(([x, y], i) => {
      if (i === 0) return `M ${x.toFixed(2)} ${y.toFixed(2)}`;
      const [px, py] = points[i - 1];
      const cx = (px + x) / 2;
      return `C ${cx.toFixed(2)} ${py.toFixed(2)}, ${cx.toFixed(2)} ${y.toFixed(2)}, ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  const area = `${path} L ${width} ${height} L 0 ${height} Z`;
  const stroke =
    direction === "down" ? "var(--danger)" : direction === "up" ? "var(--success)" : "var(--muted-foreground)";
  const gradientId = `spark-${direction}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn("overflow-visible", className)}
      aria-hidden
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={path} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
