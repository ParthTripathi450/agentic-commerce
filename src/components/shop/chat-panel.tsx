"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Send, Sparkles } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * The shopping conversation.
 *
 * A transcript, not a search box: the agent asks, the shopper answers, and the
 * agent may ask again. Both sides stay on screen so the shopper can see what
 * the agent believes and correct it — which is the whole point of asking rather
 * than guessing.
 *
 * Chips are shortcuts, never a cage: the text box is always live, and a typed
 * answer goes through exactly the same understanding step as a tapped one.
 */

export type ChatMessage =
  | { role: "agent"; content: string; note?: string }
  | { role: "shopper"; content: string }
  | { role: "results"; content: string };

export function ChatPanel({
  messages,
  chips,
  pending,
  degraded,
  placeholder,
  onSend,
  onSkip,
  onReset,
  children,
}: {
  messages: ChatMessage[];
  chips: { label: string; value: string }[];
  pending: boolean;
  degraded: boolean;
  placeholder: string;
  onSend: (text: string) => void;
  onSkip: () => void;
  onReset: () => void;
  /** Result cards, rendered inside the transcript once the agent has ranked. */
  children?: React.ReactNode;
}) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest turn in view as the conversation grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, pending, children]);

  const send = () => {
    const text = draft.trim();
    if (!text || pending) return;
    setDraft("");
    onSend(text);
  };

  return (
    <div className="flex min-h-[34rem] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm lg:min-h-[42rem]">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Sparkles className="size-4" aria-hidden />
          </span>
          <div>
            <p className="text-sm font-medium">Shopping agent</p>
            <p className="text-xs text-muted-foreground">
              {degraded
                ? "Running on deterministic rules — no AI provider reachable"
                : "Ask for anything; I&rsquo;ll ask back if I need to"}
            </p>
          </div>
        </div>
        {messages.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={onReset} disabled={pending}>
            New search
          </Button>
        ) : null}
      </header>

      {/* The transcript itself grows; the composer below stays put. */}
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5" aria-live="polite">
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Tell me what you are after — even vaguely. &ldquo;I want shoes&rdquo; is enough to start;
            I&rsquo;ll ask what I need to know.
          </p>
        ) : null}

        {messages.map((m, i) =>
          m.role === "results" ? (
            <div key={`r-${i}`} className="space-y-3">
              <Bubble role="agent">{m.content}</Bubble>
              {children}
            </div>
          ) : (
            <Bubble key={`${m.role}-${i}`} role={m.role} note={"note" in m ? m.note : undefined}>
              {m.content}
            </Bubble>
          ),
        )}

        {pending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Thinking…
          </div>
        ) : null}
        <div ref={endRef} />
      </div>

      <footer className="space-y-3 border-t border-border px-5 py-4">
        {chips.length > 0 && !pending ? (
          <div className="flex flex-wrap gap-1.5">
            {chips.map((chip) => (
              <button
                key={chip.label}
                type="button"
                onClick={() => onSend(chip.value || chip.label)}
                className="rounded-full border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:border-primary hover:bg-primary/5 hover:text-primary"
              >
                {chip.label}
              </button>
            ))}
            <button
              type="button"
              onClick={onSkip}
              className="rounded-full px-3 py-1.5 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Just show me options
            </button>
          </div>
        ) : null}

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            aria-label="Message the shopping agent"
            disabled={pending}
            className="flex-1"
          />
          <Button type="submit" disabled={pending || !draft.trim()} aria-label="Send">
            <Send className="size-4" aria-hidden />
          </Button>
        </form>
      </footer>
    </div>
  );
}

function Bubble({
  role,
  note,
  children,
}: {
  role: "agent" | "shopper";
  note?: string;
  children: React.ReactNode;
}) {
  const isShopper = role === "shopper";
  return (
    <div className={cn("flex", isShopper ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm",
          isShopper
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : "rounded-bl-sm bg-surface-2 text-foreground",
        )}
      >
        <p className="whitespace-pre-wrap">{children}</p>
        {note ? (
          <p
            className={cn(
              "mt-1.5 border-t pt-1.5 text-xs",
              isShopper ? "border-white/20 text-white/70" : "border-border text-muted-foreground",
            )}
          >
            {note}
          </p>
        ) : null}
      </div>
    </div>
  );
}
