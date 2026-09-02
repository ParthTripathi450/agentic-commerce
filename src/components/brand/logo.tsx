import { cn } from "@/lib/utils";

/**
 * Brand mark.
 *
 * A shopping bag whose handle is drawn as a two-node link — commerce plus the
 * agent graph that now transacts on it. Rendered as inline SVG so it inherits
 * currentColor, stays crisp at any size, and costs no network request.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      role="img"
      aria-label="Agentic Commerce"
      className={cn("size-8", className)}
    >
      <defs>
        <linearGradient id="acp-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#9E77ED" />
          <stop offset="100%" stopColor="#6941C6" />
        </linearGradient>
      </defs>

      <rect width="32" height="32" rx="9" fill="url(#acp-mark)" />

      {/* Bag body */}
      <path
        d="M9.5 12.75h13a1 1 0 0 1 1 1.06l-.62 8.4a2.4 2.4 0 0 1-2.4 2.22h-8.96a2.4 2.4 0 0 1-2.4-2.22l-.62-8.4a1 1 0 0 1 1-1.06Z"
        fill="none"
        stroke="#fff"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />

      {/* Handle, drawn as a link between two agent nodes */}
      <path
        d="M12.4 12.4a3.6 3.6 0 0 1 7.2 0"
        fill="none"
        stroke="#fff"
        strokeWidth="1.9"
        strokeLinecap="round"
        opacity="0.95"
      />
      <circle cx="12.4" cy="12.6" r="2.05" fill="url(#acp-mark)" stroke="#fff" strokeWidth="1.7" />
      <circle cx="19.6" cy="12.6" r="2.05" fill="url(#acp-mark)" stroke="#fff" strokeWidth="1.7" />
    </svg>
  );
}

export function Logo({
  className,
  showWordmark = true,
  tone = "default",
}: {
  className?: string;
  showWordmark?: boolean;
  tone?: "default" | "sidebar";
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark />
      {showWordmark ? (
        <span className="min-w-0">
          <span
            className={cn(
              "block truncate text-[15px] leading-tight font-semibold tracking-tight",
              tone === "sidebar" ? "text-sidebar-foreground" : "text-foreground",
            )}
          >
            Agentic Commerce
          </span>
          <span
            className={cn(
              "block truncate text-[11px] leading-tight",
              tone === "sidebar" ? "text-sidebar-muted" : "text-muted-foreground",
            )}
          >
            marketplace for AI buyers
          </span>
        </span>
      ) : null}
    </span>
  );
}
