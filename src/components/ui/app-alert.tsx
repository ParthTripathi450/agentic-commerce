import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { toneStyles, type Tone } from "./tone";

export function Alert({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn("rounded-lg border px-4 py-3 text-sm", toneStyles[tone], className)}
    >
      {title ? <p className="mb-0.5 font-semibold">{title}</p> : null}
      <div className="leading-relaxed">{children}</div>
    </div>
  );
}
