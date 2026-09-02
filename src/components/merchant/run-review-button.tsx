"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { runReviewAction } from "@/server/agents/merchant/actions";

export function RunReviewButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-3">
      {message ? <span className="text-xs text-muted-foreground">{message}</span> : null}
      <Button
        disabled={pending}
        onClick={() => {
          setMessage(null);
          startTransition(async () => {
            const result = await runReviewAction();
            setMessage(
              result.created === 0
                ? "No new findings — everything already open is still open."
                : `${result.created} new recommendation${result.created === 1 ? "" : "s"}.`,
            );
            router.refresh();
          });
        }}
      >
        {pending ? "Analysing…" : "Run a review"}
      </Button>
    </div>
  );
}
