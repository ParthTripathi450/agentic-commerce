"use client";

import { useState } from "react";
import { MessageCircleQuestion } from "lucide-react";
import { Badge, Button, Card, CardBody, Input } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { TurnDto } from "@/server/agents/customer/dto";

/**
 * The agent's clarifying question.
 *
 * Every question carries its own rationale, because an agent that interrogates
 * without saying why feels like a form. The options are catalogue-derived — the
 * agent can only offer what it can actually search on — and free text is always
 * available, since a chip list is a shortcut, not a cage.
 */
export function ClarifyPanel({
  turn,
  pending,
  onAnswer,
  onSkipAll,
}: {
  turn: TurnDto;
  pending: boolean;
  onAnswer: (slotId: string, value: string) => void;
  onSkipAll: () => void;
}) {
  const [freeText, setFreeText] = useState("");
  const question = turn.question;
  if (!question) return null;

  const submitFreeText = () => {
    const value = freeText.trim();
    if (!value) return;
    setFreeText("");
    onAnswer(question.id, value);
  };

  return (
    <Card className="border-2 border-primary/30">
      <CardBody className="space-y-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <MessageCircleQuestion className="size-4" aria-hidden />
          </span>
          <div className="space-y-1">
            <p className="text-base font-medium">{question.question}</p>
            <p className="text-xs text-muted-foreground">{question.rationale}</p>
          </div>
        </div>

        {turn.known.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-subtle">So far:</span>
            {turn.known.map((k) => (
              <Badge key={k} tone="neutral">
                {k}
              </Badge>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {question.options.map((option) => (
            <Button
              key={`${option.label}-${option.value}`}
              size="sm"
              variant={option.value === "" ? "ghost" : "secondary"}
              disabled={pending}
              onClick={() => onAnswer(question.id, option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={freeText}
            disabled={pending}
            placeholder="…or answer in your own words"
            aria-label={question.question}
            className="min-w-56 flex-1"
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitFreeText();
              }
            }}
          />
          <Button size="sm" disabled={pending || !freeText.trim()} onClick={submitFreeText}>
            {pending ? "…" : "Answer"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={onSkipAll}
            className={cn("text-xs")}
          >
            Just show me options
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

/** Compact transcript of the exchange so far, so the shopper can see the agent's basis. */
export function ConversationTrail({
  entries,
}: {
  entries: { question: string; answer: string }[];
}) {
  if (entries.length === 0) return null;
  return (
    <ol className="space-y-1.5 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
      {entries.map((e, i) => (
        <li key={`${e.question}-${i}`} className="flex flex-wrap gap-x-2">
          <span className="text-muted-foreground">{e.question}</span>
          <span className="font-medium">{e.answer || "no preference"}</span>
        </li>
      ))}
    </ol>
  );
}
