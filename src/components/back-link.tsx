"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

/**
 * Back navigation for pages a shopper arrives at from somewhere specific.
 *
 * Uses history rather than a hard-coded destination, because a product page is
 * reached from search, from a recommendation, from the popular grid and from
 * an order — sending everyone to /shop would be wrong for three of those. The
 * `fallback` covers a page opened directly, where there is no history to
 * return to.
 */
export function BackLink({
  fallback = "/shop",
  label = "Back",
}: {
  fallback?: string;
  label?: string;
}) {
  const router = useRouter();

  return (
    <button
      type="button"
      onClick={() => {
        if (window.history.length > 1) router.back();
        else router.push(fallback);
      }}
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {label}
    </button>
  );
}
