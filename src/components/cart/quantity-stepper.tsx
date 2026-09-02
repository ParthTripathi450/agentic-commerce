"use client";

import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Quantity control.
 *
 * Bounded by what is actually in stock, so the shopper cannot select a number
 * the merchant cannot fulfil — the constraint belongs here, not only in a
 * server error after they commit.
 */
export function QuantityStepper({
  value,
  onChange,
  max,
  disabled,
  size = "md",
}: {
  value: number;
  onChange: (next: number) => void;
  max: number;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  const limit = Math.max(1, Math.min(max, 10));
  const button =
    "grid place-items-center rounded-md border border-input bg-card text-muted-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40";
  const dimension = size === "sm" ? "size-7" : "size-8";

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        aria-label="Decrease quantity"
        className={cn(button, dimension)}
        disabled={disabled || value <= 1}
        onClick={() => onChange(value - 1)}
      >
        <Minus className="size-3.5" strokeWidth={2.5} />
      </button>

      <span
        className={cn(
          "tabular grid place-items-center rounded-md border border-input bg-card font-medium",
          size === "sm" ? "h-7 w-9 text-xs" : "h-8 w-11 text-sm",
        )}
        aria-live="polite"
      >
        {value}
      </span>

      <button
        type="button"
        aria-label="Increase quantity"
        className={cn(button, dimension)}
        disabled={disabled || value >= limit}
        onClick={() => onChange(value + 1)}
      >
        <Plus className="size-3.5" strokeWidth={2.5} />
      </button>

      {max <= 10 ? (
        <span className="ml-1 text-xs text-subtle">
          {max === 0 ? "out of stock" : `${max} available`}
        </span>
      ) : null}
    </div>
  );
}
