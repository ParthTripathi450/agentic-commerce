import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { toneStyles, type Tone } from "./tone";

export function Badge({
  className,
  tone = "neutral",
  ...props
}: ComponentProps<"span"> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        toneStyles[tone],
        className,
      )}
      {...props}
    />
  );
}
