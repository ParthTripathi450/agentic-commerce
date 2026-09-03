"use client";

import { cn } from "@/lib/utils";

/**
 * The rated features of a product.
 *
 * These were previously invisible: the scores live in `attributes.qualities`,
 * and the specifications list rendered them through `String(value)` — so a
 * shopper searching for waterproof shoes saw "qualities: [object Object]"
 * instead of the water-resistance rating that answered their question.
 *
 * Shown strongest first, with the number as well as the bar: "4/5" is a claim a
 * shopper can weigh, whereas a bar alone is decoration.
 */

const LABELS: Record<string, string> = {
  durability: "Durability",
  comfort: "Comfort",
  breathability: "Breathability",
  waterResistance: "Water resistance",
  grip: "Grip",
  warmth: "Warmth",
  materialQuality: "Material quality",
  support: "Support",
  packability: "Packability",
  easeOfCare: "Ease of care",
  batteryLife: "Battery life",
  soundQuality: "Sound quality",
  noiseIsolation: "Noise isolation",
  portability: "Portability",
  capacity: "Capacity",
  heatRetention: "Heat retention",
  sharpness: "Sharpness",
  nonStick: "Non-stick",
  absorbency: "Absorbency",
  softness: "Softness",
  brightness: "Brightness",
  stability: "Stability",
};

export function humanizeQuality(key: string): string {
  return (
    LABELS[key] ??
    key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim()
  );
}

export type QualityMap = Record<string, number>;

/** Pulls the scores out of a product's attributes, ignoring everything else. */
export function extractQualities(attributes: Record<string, unknown>): QualityMap {
  const raw = attributes?.qualities;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
}

export function QualityBars({
  qualities,
  limit,
  className,
}: {
  qualities: QualityMap;
  limit?: number;
  className?: string;
}) {
  const rows = Object.entries(qualities).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return null;
  const shown = limit ? rows.slice(0, limit) : rows;

  return (
    <dl className={cn("grid gap-2 sm:grid-cols-2", className)}>
      {shown.map(([key, score]) => (
        <div key={key} className="flex items-center gap-2.5">
          <dt className="w-32 shrink-0 truncate text-xs text-muted-foreground">
            {humanizeQuality(key)}
          </dt>
          <dd className="flex flex-1 items-center gap-2">
            <span className="flex gap-0.5" aria-hidden>
              {[1, 2, 3, 4, 5].map((step) => (
                <span
                  key={step}
                  className={cn(
                    "h-1.5 w-4 rounded-full",
                    step <= score
                      ? score >= 4
                        ? "bg-success"
                        : score >= 3
                          ? "bg-primary/60"
                          : "bg-warning"
                      : "bg-border",
                  )}
                />
              ))}
            </span>
            {/* The number, not just the bar — a bar alone is decoration. */}
            <span className="tabular text-xs font-medium">{score}/5</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Compact form for a result card: only what this product is genuinely good at. */
export function QualityHighlights({ qualities }: { qualities: QualityMap }) {
  const strong = Object.entries(qualities)
    .filter(([, v]) => v >= 4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  if (strong.length === 0) return null;

  return (
    <ul className="flex flex-wrap gap-1.5">
      {strong.map(([key, score]) => (
        <li
          key={key}
          className="rounded-full border border-success/30 bg-success-soft/40 px-2 py-0.5 text-xs"
        >
          {humanizeQuality(key)} {score}/5
        </li>
      ))}
    </ul>
  );
}
