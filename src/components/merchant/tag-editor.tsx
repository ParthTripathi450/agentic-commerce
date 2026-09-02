"use client";

import { useState } from "react";
import { Plus, Sparkles, X } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Search-tag editor.
 *
 * Tags are ranked above the description in the search index, so they are the
 * highest-leverage field on a listing — and therefore the one a merchant most
 * needs to be able to correct. Whatever the agent proposed is fully editable:
 * add, rename, remove.
 */
export function TagEditor({
  tags,
  onChange,
  onRegenerate,
  regenerating,
  aiProposed,
}: {
  tags: string[];
  onChange: (next: string[]) => void;
  onRegenerate?: () => void;
  regenerating?: boolean;
  /** Tags the agent suggested, so merchant edits are visually distinguishable. */
  aiProposed?: string[];
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const value = draft.toLowerCase().trim().replace(/\s+/g, " ");
    if (!value || value.length < 2) return;
    if (tags.some((t) => t.toLowerCase() === value)) {
      setDraft("");
      return;
    }
    onChange([...tags, value].slice(0, 14));
    setDraft("");
  };

  const proposed = new Set((aiProposed ?? []).map((t) => t.toLowerCase()));

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        {tags.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No tags yet. Tags are what shoppers actually type — use cases and synonyms, not the
            product name.
          </p>
        ) : null}

        {tags.map((tag) => (
          <span
            key={tag}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs",
              proposed.has(tag.toLowerCase())
                ? "border-transparent bg-primary-soft text-accent-foreground"
                : "border-input bg-card",
            )}
          >
            {tag}
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              onClick={() => onChange(tags.filter((t) => t !== tag))}
              className="rounded-full p-0.5 text-muted-foreground transition-colors hover:text-danger"
            >
              <X className="size-3" strokeWidth={2.5} />
            </button>
          </span>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          placeholder="e.g. marathon training"
          maxLength={40}
          className="max-w-56"
        />
        <Button type="button" size="sm" variant="secondary" onClick={add} disabled={tags.length >= 14}>
          <Plus className="size-4" />
          Add tag
        </Button>
        {onRegenerate ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onRegenerate}
            disabled={regenerating}
          >
            <Sparkles className="size-4" />
            {regenerating ? "Thinking…" : "Suggest more"}
          </Button>
        ) : null}
      </div>

      <p className="text-xs text-subtle">
        {tags.length}/14 tags. Ranked above the description in search, so a tag match beats a
        mention in the body copy.
        {aiProposed?.length ? " Highlighted tags were proposed by the agent." : ""}
      </p>
    </div>
  );
}
