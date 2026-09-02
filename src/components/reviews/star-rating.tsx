"use client";

import { useState } from "react";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Star input.
 *
 * Rendered as real radio inputs so it is keyboard-operable and announced
 * correctly; the stars are the visual layer over that. A rating is never
 * conveyed by colour alone — the chosen value is always written out beside it.
 */
export function StarRating({
  name,
  defaultValue,
  onChange,
  size = "md",
}: {
  name: string;
  defaultValue?: number | null;
  onChange?: (value: number) => void;
  size?: "sm" | "md";
}) {
  const [value, setValue] = useState(defaultValue ?? 0);
  const [hovered, setHovered] = useState(0);
  const shown = hovered || value;
  const starSize = size === "sm" ? "size-4" : "size-6";

  return (
    <div className="flex items-center gap-2">
      <fieldset className="flex items-center gap-0.5" onMouseLeave={() => setHovered(0)}>
        <legend className="sr-only">Rating out of 5</legend>
        {[1, 2, 3, 4, 5].map((star) => (
          <label
            key={star}
            className="cursor-pointer p-0.5"
            onMouseEnter={() => setHovered(star)}
            title={`${star} star${star === 1 ? "" : "s"}`}
          >
            <input
              type="radio"
              name={name}
              value={star}
              defaultChecked={defaultValue === star}
              onChange={() => {
                setValue(star);
                onChange?.(star);
              }}
              className="sr-only peer"
            />
            <Star
              className={cn(
                starSize,
                "transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring rounded-sm",
                star <= shown
                  ? "fill-warning text-warning"
                  : "fill-transparent text-muted-foreground/40",
              )}
              strokeWidth={1.75}
            />
          </label>
        ))}
      </fieldset>
      <span className="text-sm text-muted-foreground tabular">
        {shown > 0 ? `${shown} of 5` : "Not rated"}
      </span>
    </div>
  );
}

/** Read-only stars, for displaying an existing rating. */
export function StarDisplay({
  stars,
  count,
  className,
}: {
  stars: number;
  count?: number;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className="inline-flex" aria-hidden>
        {[1, 2, 3, 4, 5].map((star) => (
          <Star
            key={star}
            className={cn(
              "size-3.5",
              star <= Math.round(stars)
                ? "fill-warning text-warning"
                : "fill-transparent text-muted-foreground/35",
            )}
            strokeWidth={1.75}
          />
        ))}
      </span>
      <span className="tabular text-xs text-muted-foreground">
        {stars.toFixed(1)}
        {count !== undefined ? ` (${count})` : ""}
      </span>
    </span>
  );
}
