"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { reindexCatalogAction } from "@/server/catalog/actions";

export function ReindexButton() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await reindexCatalogAction();
            setMessage(
              `Re-indexed ${result.indexed} of ${result.total} products in ${(result.durationMs / 1000).toFixed(1)}s.`,
            );
          })
        }
      >
        {pending ? "Re-indexing…" : "Rebuild AI catalog"}
      </Button>
      {message ? <span className="text-xs text-muted-foreground">{message}</span> : null}
    </div>
  );
}
