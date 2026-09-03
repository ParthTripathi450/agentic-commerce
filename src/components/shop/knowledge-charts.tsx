import { formatMoney } from "@/lib/money";
import type { KnowledgeBase, Preference } from "@/server/shopper/knowledge";

/**
 * The knowledge base drawn rather than listed.
 *
 * Hand-rolled inline SVG, matching the sparklines elsewhere. Recharts is a
 * substantial download and is deliberately scoped to the merchant revenue
 * chart; none of these needs a charting library, and putting one on the
 * shopper's critical path to draw four static shapes would be a poor trade.
 * There are no hooks and no interaction here, so each is just markup.
 *
 * Two rules run through all of them. **Bars are drawn relative to the strongest
 * preference, never to an absolute scale** — the underlying score is a sum of
 * arbitrary weights, so "12.4" means nothing on its own and only the comparison
 * between preferences is real. And **every shape is accompanied by its numbers
 * in text**, so nothing is conveyed by geometry or colour alone.
 */

/**
 * The shape of a shopper's taste across rated qualities.
 *
 * A radar earns its place here specifically because qualities are commensurable
 * — every product is scored 1–5 on the same axes — and because the interesting
 * thing about them is the SHAPE: someone who wants comfort and breathability
 * but not durability has a profile you can recognise at a glance and would have
 * to read six rows to reconstruct from a list.
 */
export function QualityRadar({ qualities }: { qualities: Preference[] }) {
  // Below three axes a radar degenerates into a line or a point and says less
  // than the list it replaced.
  const axes = qualities.slice(0, 8);
  if (axes.length < 3) return null;

  const peak = Math.max(...axes.map((a) => a.score), 1);
  const size = 260;
  const centre = size / 2;
  const radius = centre - 54; // room for the labels outside the web
  const rings = [0.25, 0.5, 0.75, 1];

  const pointAt = (index: number, distance: number) => {
    // Start at twelve o'clock and go clockwise, which is how these are read.
    const angle = (Math.PI * 2 * index) / axes.length - Math.PI / 2;
    return {
      x: centre + Math.cos(angle) * radius * distance,
      y: centre + Math.sin(angle) * radius * distance,
    };
  };

  const shape = axes
    .map((axis, i) => {
      const p = pointAt(i, Math.max(axis.score / peak, 0.06));
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="mx-auto h-auto w-full max-w-[260px]"
        role="img"
        aria-label={`Your taste across ${axes.length} qualities. Strongest: ${axes[0].value}.`}
      >
        {rings.map((ring) => (
          <polygon
            key={ring}
            points={axes.map((_, i) => {
              const p = pointAt(i, ring);
              return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
            }).join(" ")}
            className="fill-none stroke-border"
            strokeWidth={1}
          />
        ))}

        {axes.map((axis, i) => {
          const end = pointAt(i, 1);
          return (
            <line
              key={axis.value}
              x1={centre}
              y1={centre}
              x2={end.x}
              y2={end.y}
              className="stroke-border"
              strokeWidth={1}
            />
          );
        })}

        <polygon points={shape} className="fill-primary/25 stroke-primary" strokeWidth={2} />

        {axes.map((axis, i) => {
          const p = pointAt(i, Math.max(axis.score / peak, 0.06));
          return <circle key={axis.value} cx={p.x} cy={p.y} r={3} className="fill-primary" />;
        })}

        {axes.map((axis, i) => {
          const label = pointAt(i, 1.18);
          // Anchoring by which side of the centre the label sits on keeps the
          // text off the web instead of overprinting it.
          const anchor =
            Math.abs(label.x - centre) < 12 ? "middle" : label.x > centre ? "start" : "end";
          return (
            <text
              key={axis.value}
              x={label.x}
              y={label.y}
              textAnchor={anchor}
              dominantBaseline="middle"
              className="fill-muted-foreground text-[9px]"
            >
              {humanise(axis.value)}
            </text>
          );
        })}
      </svg>
      <figcaption className="mt-2 text-center text-xs text-muted-foreground">
        Relative emphasis across the qualities your purchases score well on.
      </figcaption>
    </figure>
  );
}

/**
 * Ranked preferences as horizontal bars.
 *
 * Labelled with the product count rather than the score: the count is the
 * actual reason a preference is credible, and it is a number the reader can
 * check against their own order history. The bar carries the comparison; the
 * text carries the evidence.
 */
export function PreferenceBars({
  items,
  tone = "positive",
}: {
  items: Preference[];
  tone?: "positive" | "negative";
}) {
  if (items.length === 0) return null;
  const peak = Math.max(...items.map((i) => Math.abs(i.score)), 1);

  return (
    <ul className="space-y-1.5">
      {items.map((item) => {
        const share = Math.max(Math.abs(item.score) / peak, 0.04);
        return (
          <li key={item.value} className="grid grid-cols-[8rem_1fr_auto] items-center gap-2">
            <span className="truncate text-sm" title={item.value}>
              {humanise(item.value)}
            </span>
            <span
              className="h-2.5 rounded-full bg-muted"
              role="img"
              aria-label={`${item.confidence} preference, from ${item.products} product${item.products === 1 ? "" : "s"}`}
            >
              <span
                className={
                  "block h-full rounded-full " + (tone === "negative" ? "bg-danger" : "bg-primary")
                }
                style={{ width: `${(share * 100).toFixed(1)}%` }}
              />
            </span>
            <span className="tabular shrink-0 text-xs text-subtle">
              {item.confidence} · {item.products}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Where this shopper's spending actually sits.
 *
 * The interquartile range is drawn as a band with the median marked inside it,
 * because that is the honest shape of "what they usually spend" — a single
 * average would imply a precision the data does not have, and a shopper whose
 * orders run ₹800 to ₹9,000 is not well described by one number.
 */
export function SpendRange({ budget }: { budget: NonNullable<KnowledgeBase["budget"]> }) {
  const { p25Minor, medianMinor, p75Minor } = budget;
  // The axis runs to a third beyond the upper quartile so the band sits inside
  // the track rather than ending flush against its edge.
  const axisMax = Math.max(p75Minor * 1.33, medianMinor * 1.2, 1);
  const pct = (v: number) => Math.min(100, (v / axisMax) * 100);

  return (
    <figure className="m-0 space-y-2">
      <div
        className="relative h-8 rounded-lg bg-muted"
        role="img"
        aria-label={`Usually spends between ${formatMoney(p25Minor)} and ${formatMoney(p75Minor)} per item, median ${formatMoney(medianMinor)}.`}
      >
        <div
          className="absolute inset-y-0 rounded-lg bg-primary/25"
          style={{ left: `${pct(p25Minor)}%`, width: `${pct(p75Minor) - pct(p25Minor)}%` }}
        />
        <div
          className="absolute inset-y-1 w-0.5 rounded-full bg-primary"
          style={{ left: `${pct(medianMinor)}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span className="tabular">{formatMoney(p25Minor)}</span>
        <span className="tabular font-medium text-foreground">
          {formatMoney(medianMinor)} typical
        </span>
        <span className="tabular">{formatMoney(p75Minor)}</span>
      </div>
      <figcaption className="text-xs text-subtle">
        The shaded band is the middle half of {budget.orders} orders. The agent treats it as a hint,
        never a cap — something cheaper than usual is never penalised.
      </figcaption>
    </figure>
  );
}

/**
 * How much each kind of evidence contributes, as one stacked bar.
 *
 * The point it makes is the point of the whole feature: purchases and reviews
 * dominate, browsing barely registers. Showing that is more convincing than
 * asserting it in a paragraph nobody reads.
 */
export function EvidenceMix({ evidence }: { evidence: KnowledgeBase["evidence"] }) {
  const bands = [
    { label: "Bought", value: evidence.purchases, className: "bg-primary" },
    { label: "Reviewed", value: evidence.reviews, className: "bg-primary/70" },
    { label: "Basketed", value: evidence.baskets, className: "bg-primary/45" },
    { label: "Browsed", value: evidence.browsed, className: "bg-primary/20" },
  ].filter((b) => b.value > 0);

  const total = bands.reduce((sum, b) => sum + b.value, 0);
  if (total === 0) return null;

  return (
    <figure className="m-0 space-y-2">
      <div className="flex h-3 overflow-hidden rounded-full bg-muted" role="img" aria-label={
        bands.map((b) => `${b.label}: ${b.value}`).join(", ")
      }>
        {bands.map((band) => (
          <span
            key={band.label}
            className={band.className}
            style={{ width: `${((band.value / total) * 100).toFixed(1)}%` }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {bands.map((band) => (
          <li key={band.label} className="flex items-center gap-1.5">
            <span className={`size-2 rounded-full ${band.className}`} aria-hidden />
            {band.label} <span className="tabular font-medium text-foreground">{band.value}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** Quality keys arrive camelCased from the catalogue's own attributes. */
function humanise(value: string): string {
  const spaced = value.replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
