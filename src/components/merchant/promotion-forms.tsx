"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Card, CardBody, CardHeader, CardTitle, Field, Input, Select } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import {
  createPromotionAction,
  deletePromotionAction,
  togglePromotionAction,
} from "@/server/merchant/promotion-actions";

type State = { ok?: boolean; message?: string; error?: string } | null;

export function CreatePromotionForm({ categories }: { categories: string[] }) {
  const [state, action, pending] = useActionState<State, FormData>(createPromotionAction, null);
  const [type, setType] = useState("percentage_off");

  return (
    <Card>
      <CardHeader>
        <CardTitle>New promotion</CardTitle>
      </CardHeader>
      <CardBody>
        <form action={action} className="space-y-4">
          {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
          {state?.ok ? <Alert tone="success">{state.message}</Alert> : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title">
              <Input name="title" required placeholder="10% off running footwear" />
            </Field>
            <Field label="Code" hint="Blank for an always-on offer with no code">
              <Input name="code" placeholder="RUN10" className="font-mono uppercase" />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Type">
              <Select name="type" value={type} onChange={(e) => setType(e.target.value)}>
                <option value="percentage_off">Percentage off</option>
                <option value="flat_off">Flat amount off</option>
                <option value="free_shipping">Free shipping</option>
              </Select>
            </Field>
            <Field label={type === "percentage_off" ? "Discount (%)" : type === "flat_off" ? "Discount (₹)" : "Not used"}>
              <Input
                name="value"
                type="number"
                step={type === "percentage_off" ? "0.5" : "1"}
                min="0"
                defaultValue={type === "free_shipping" ? 0 : ""}
                disabled={type === "free_shipping"}
              />
            </Field>
            <Field label="Minimum order (₹)" hint="Optional">
              <Input name="minSubtotal" type="number" min="0" />
            </Field>
          </div>

          <Field label="Ends on" hint="Optional — leave blank to run until you pause it">
            <Input name="activeTo" type="date" />
          </Field>

          {/*
            * Which categories the offer covers.
            *
            * Read from this merchant's own catalogue rather than a fixed list:
            * scoping a promotion to something they do not stock would never
            * apply and they would have no way to tell why.
            */}
          {categories.length > 0 ? (
            <fieldset className="space-y-2">
              <legend className="text-xs font-medium text-muted-foreground">
                Which products? Leave all unticked to cover your whole catalogue.
              </legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {categories.map((category) => (
                  <label key={category} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      name="categories"
                      value={category}
                      className="size-4 accent-primary"
                    />
                    {category}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          <Button type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create promotion"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

export function PromotionRow({
  promotion,
}: {
  promotion: {
    id: string;
    title: string;
    code: string | null;
    type: string;
    value: number;
    active: boolean;
    activeTo: string | null;
    createdByAgent: boolean;
    minSubtotalMinor: number | null;
    categories: string[];
  };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok?: boolean; error?: string } | undefined>) =>
    startTransition(async () => {
      setError(null);
      const result = await fn();
      if (result?.error) setError(result.error);
      else router.refresh();
    });

  const amount =
    promotion.type === "percentage_off"
      ? `${(promotion.value / 100).toFixed(promotion.value % 100 === 0 ? 0 : 1)}% off`
      : promotion.type === "flat_off"
        ? `${formatMoney(promotion.value)} off`
        : "Free shipping";

  const expired = promotion.activeTo ? new Date(promotion.activeTo) < new Date() : false;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3 last:border-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{promotion.title}</span>
          {promotion.code ? (
            <Badge tone="accent" className="font-mono">{promotion.code}</Badge>
          ) : null}
          {promotion.createdByAgent ? <Badge tone="info">created by agent</Badge> : null}
          {expired ? <Badge tone="neutral">expired</Badge> : null}
          <Badge tone={promotion.active && !expired ? "success" : "neutral"}>
            {promotion.active && !expired ? "live" : "paused"}
          </Badge>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {amount}
          {promotion.minSubtotalMinor ? ` · orders above ${formatMoney(promotion.minSubtotalMinor)}` : ""}
          {promotion.activeTo ? ` · until ${new Date(promotion.activeTo).toLocaleDateString("en-IN")}` : ""}
          {promotion.categories.length > 0
            ? ` · ${promotion.categories.join(", ")} only`
            : " · whole catalogue"}
          {/*
            * Days remaining, spelled out.
            *
            * "until 12/09/2026" makes a shopper do the arithmetic; "ends in 3
            * days" is the thing they actually want to know, and it is what
            * decides whether they buy today.
            */}
          {daysLeft(promotion.activeTo) !== null && !expired
            ? ` · ends in ${daysLeft(promotion.activeTo)} day${daysLeft(promotion.activeTo) === 1 ? "" : "s"}`
            : ""}
        </p>
        {error ? <p className="mt-0.5 text-xs text-danger">{error}</p> : null}
      </div>

      <div className="flex gap-1">
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => run(() => togglePromotionAction(promotion.id, !promotion.active))}
        >
          {promotion.active ? "Pause" : "Resume"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => run(() => deletePromotionAction(promotion.id))}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

/** Whole days from now until a promotion stops, or null if it never does. */
export function daysLeft(activeTo: string | null): number | null {
  if (!activeTo) return null;
  const ms = new Date(activeTo).getTime() - Date.now();
  if (ms < 0) return 0;
  // Rounded UP: an offer with six hours left has one day left, not zero.
  return Math.ceil(ms / 86_400_000);
}
