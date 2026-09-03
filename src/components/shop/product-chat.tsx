"use client";

import { useState } from "react";
import { MessageCircle, Send } from "lucide-react";
import { Button, Card, CardBody, Input } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Keep talking about the product you are already looking at.
 *
 * Scoped deliberately: the answer can only ever be a variant of THIS product,
 * so "do you have it in navy?" cannot wander off to a different shoe. When the
 * combination does not exist it says so and names what does, rather than
 * quietly showing the nearest thing.
 *
 * Selecting a variant here drives the page's own selection, so the picture,
 * price and stock follow the conversation.
 */
export function ProductChat({
  productId,
  currentVariantId,
  onVariant,
}: {
  productId: string;
  currentVariantId: string;
  /** Applies the resolved variant to the page. */
  onVariant: (variantId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [turns, setTurns] = useState<{ role: "you" | "agent"; text: string }[]>([]);

  async function ask(text: string) {
    const message = text.trim();
    if (!message || pending) return;

    setDraft("");
    setTurns((t) => [...t, { role: "you", text: message }]);
    setPending(true);

    try {
      const response = await fetch("/api/agent/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, message, currentVariantId }),
      });
      const data = await response.json();

      if (!response.ok) {
        setTurns((t) => [...t, { role: "agent", text: data.error ?? "That did not work." }]);
        return;
      }

      setTurns((t) => [...t, { role: "agent", text: data.reply }]);
      if (data.variant?.variantId && data.variant.variantId !== currentVariantId) {
        onVariant(data.variant.variantId);
      }
    } catch {
      setTurns((t) => [...t, { role: "agent", text: "Could not reach the agent just then." }]);
    } finally {
      setPending(false);
    }
  }

  const suggestions = ["Do you have it in navy?", "What's the cheapest size?", "Is it breathable?"];

  return (
    <Card>
      <CardBody className="space-y-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 text-left"
        >
          <MessageCircle className="size-4 text-primary" aria-hidden />
          <span className="text-sm font-semibold">Ask about this one</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {open ? "Hide" : "Colour, size, price — anything"}
          </span>
        </button>

        {open ? (
          <div className="space-y-3">
            {turns.length > 0 ? (
              <ol className="space-y-2">
                {turns.map((turn, i) => (
                  <li
                    key={i}
                    className={cn("flex", turn.role === "you" ? "justify-end" : "justify-start")}
                  >
                    <span
                      className={cn(
                        "max-w-[85%] rounded-2xl px-3 py-2 text-sm",
                        turn.role === "you"
                          ? "rounded-br-sm bg-primary text-primary-foreground"
                          : "rounded-bl-sm bg-surface-2",
                      )}
                    >
                      {turn.text}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void ask(s)}
                    className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            {pending ? <p className="text-xs text-muted-foreground">Checking…</p> : null}

            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void ask(draft);
              }}
            >
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="e.g. do you have it in a 9?"
                aria-label="Ask about this product"
                disabled={pending}
                className="flex-1"
              />
              <Button type="submit" disabled={pending || !draft.trim()} aria-label="Send">
                <Send className="size-4" aria-hidden />
              </Button>
            </form>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
