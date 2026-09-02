import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Label + control + hint, so every form field is described consistently. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-subtle">{hint}</span> : null}
    </label>
  );
}

/**
 * Native select.
 *
 * shadcn's Select is a Radix compound component; a plain <select> with <option>
 * children is what the forms here need, and it stays keyboard- and
 * mobile-native. Styled to match the shadcn Input.
 */
export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-9 w-full rounded-lg border border-input bg-card px-3 text-sm shadow-xs transition-colors",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-input px-6 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children ? <div className="mt-1 text-sm text-muted-foreground">{children}</div> : null}
    </div>
  );
}
