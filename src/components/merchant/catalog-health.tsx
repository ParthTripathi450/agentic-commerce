import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * AI-catalogue health, in the sidebar slot the reference design uses for a
 * storage-quota promo.
 *
 * Chosen because it answers the one question unique to this product: how much
 * of your catalogue can AI buyers actually find? A product that is not indexed
 * is invisible to every agent, however good the listing looks.
 */
export function CatalogHealth({ indexed, total }: { indexed: number; total: number }) {
  if (total === 0) return null;
  const pct = Math.round((indexed / total) * 100);
  const complete = indexed === total;

  return (
    <div className="rounded-lg border border-sidebar-border bg-sidebar-accent/50 p-3">
      <div className="flex items-center gap-3">
        <div className="relative grid size-11 shrink-0 place-items-center">
          <svg viewBox="0 0 36 36" className="size-11 -rotate-90" aria-hidden>
            <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--sidebar-border)" strokeWidth="3.5" />
            <circle
              cx="18"
              cy="18"
              r="15.5"
              fill="none"
              stroke={complete ? "var(--success)" : "var(--sidebar-primary)"}
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeDasharray={`${(pct / 100) * 97.4} 97.4`}
            />
          </svg>
          <span className="tabular absolute text-[10px] font-semibold text-sidebar-foreground">
            {pct}%
          </span>
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium text-sidebar-foreground">AI catalogue</p>
          <p className={cn("text-[11px]", complete ? "text-sidebar-muted" : "text-warning")}>
            {complete
              ? `All ${total} products discoverable`
              : `${total - indexed} not discoverable by agents`}
          </p>
        </div>
      </div>
      {!complete ? (
        <Link
          href="/merchant/protocols"
          className="mt-2 block text-[11px] font-medium text-sidebar-foreground underline underline-offset-2"
        >
          Rebuild the index
        </Link>
      ) : null}
    </div>
  );
}
