"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import { Button, Card, CardBody } from "@/components/ui";
import { cn } from "@/lib/utils";

export type CriterionRow = { key: string; label: string; hint: string; weight: number };

/**
 * What the ranking weighted, and the shopper's chance to change it.
 *
 * A ranking whose priorities are hidden cannot be argued with, so the order is
 * always shown — not tucked behind a settings page. Dragging is the quick way;
 * the up/down buttons are the real control, because drag-and-drop is
 * unusable by keyboard and awkward on a phone.
 *
 * Relevance is absent on purpose: it is not a preference, it is what keeps the
 * results about the thing that was asked for.
 */
export function PriorityEditor({
  criteria,
  pending,
  onReorder,
}: {
  criteria: CriterionRow[];
  pending: boolean;
  onReorder: (order: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [order, setOrder] = useState<CriterionRow[]>(criteria);
  const [dragging, setDragging] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);

  // A fresh turn brings a fresh order; drop any half-made edit with it.
  const signature = criteria.map((c) => c.key).join(",");
  const [seen, setSeen] = useState(signature);
  if (seen !== signature) {
    setSeen(signature);
    setOrder(criteria);
    setDirty(false);
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setOrder(next);
    setDirty(true);
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <span className="min-w-0">
            <span className="block text-sm font-semibold">How these were ranked</span>
            <span className="block truncate text-xs text-muted-foreground">
              {order.map((c) => c.label).join(" › ")}
            </span>
          </span>
          <ChevronDown
            className={cn("size-4 shrink-0 text-primary transition-transform", open && "rotate-180")}
          />
        </button>

        {open ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Most important first. Drag a row, or use the arrows. Matching what you asked for is
              always weighted first and is not in this list.
            </p>

            <ol className="space-y-1.5">
              {order.map((criterion, index) => (
                <li
                  key={criterion.key}
                  draggable={!pending}
                  onDragStart={() => setDragging(index)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragging !== null) move(dragging, index);
                    setDragging(null);
                  }}
                  onDragEnd={() => setDragging(null)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2",
                    dragging === index && "opacity-50",
                  )}
                >
                  <GripVertical className="size-4 shrink-0 cursor-grab text-subtle" aria-hidden />
                  <span className="w-5 shrink-0 text-xs font-semibold text-muted-foreground">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{criterion.label}</span>
                    <span className="block text-xs text-muted-foreground">{criterion.hint}</span>
                  </span>
                  <span className="tabular shrink-0 text-xs text-muted-foreground">
                    {Math.round(criterion.weight * 100)}%
                  </span>
                  <span className="flex shrink-0 flex-col">
                    <button
                      type="button"
                      aria-label={`Move ${criterion.label} up`}
                      disabled={index === 0 || pending}
                      onClick={() => move(index, index - 1)}
                      className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                    >
                      <ChevronUp className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${criterion.label} down`}
                      disabled={index === order.length - 1 || pending}
                      onClick={() => move(index, index + 1)}
                      className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                    >
                      <ChevronDown className="size-3.5" />
                    </button>
                  </span>
                </li>
              ))}
            </ol>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={!dirty || pending}
                onClick={() => onReorder(order.map((c) => c.key))}
              >
                {pending ? "Re-ranking…" : "Re-rank with this order"}
              </Button>
              {dirty ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    setOrder(criteria);
                    setDirty(false);
                  }}
                >
                  Reset
                </Button>
              ) : null}
              <span className="text-xs text-subtle">
                The percentages are the actual weights used to score every option.
              </span>
            </div>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
