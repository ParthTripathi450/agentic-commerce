"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Alert, Badge, Button, Card, CardBody } from "@/components/ui";
import {
  EvidenceMix,
  PreferenceBars,
  QualityRadar,
  SpendRange,
} from "@/components/shop/knowledge-charts";
import { clearBrowsingSignalsAction } from "@/server/shopper/actions";
import type { KnowledgeBase, Preference } from "@/server/shopper/knowledge";

/**
 * The knowledge base, shown to the person it is about.
 *
 * Every row names its evidence — how many distinct products it rests on, and
 * how confident that makes it. A profile that quietly steers what someone is
 * shown, without telling them it exists or what it thinks, is the thing people
 * rightly object to about recommenders; the fix is not to profile less, it is
 * to show the profile.
 */
export function KnowledgePanel({ knowledge }: { knowledge: KnowledgeBase }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const { likes, dislikes, evidence } = knowledge;
  const hasDislikes =
    dislikes.brands.length > 0 || dislikes.categories.length > 0 || dislikes.qualities.length > 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="space-y-1">
          <h2 className="text-sm font-semibold">What this is built from</h2>
          <p className="text-sm text-muted-foreground">
            Only your own activity, weighted by how much each action costs you. Paying for something
            counts most; a review counts more still, because it is you correcting a decision you had
            already made. Opening a page counts least.
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Items bought" value={evidence.purchases} />
            <Stat label="Reviews written" value={evidence.reviews} />
            <Stat label="In baskets" value={evidence.baskets} />
            <Stat label="Products opened" value={evidence.browsed} />
          </dl>
          <div className="pt-2">
            <EvidenceMix evidence={evidence} />
          </div>
        </CardBody>
      </Card>

      {knowledge.isEmpty ? (
        <Alert tone="neutral" title="Nothing learned yet">
          Buy something, review something, or browse a few products and this page will fill in. Until
          then the agent ranks purely on what you tell it in the conversation.
        </Alert>
      ) : null}

      <Card>
        <CardBody className="space-y-5">
          <h2 className="text-sm font-semibold">What you seem to like</h2>

          {/*
            * Bars where the question is "which of these is strongest", chips
            * where it is "which ones are there". A size or a colour is a set
            * you scan; a category ranking is a comparison you read.
            */}
          <ChartRow label="Categories" items={likes.categories}>
            <PreferenceBars items={likes.categories} />
          </ChartRow>
          <ChartRow label="Brands" items={likes.brands}>
            <PreferenceBars items={likes.brands} />
          </ChartRow>

          {likes.qualities.length >= 3 ? (
            <ChartRow
              label="Qualities"
              items={likes.qualities}
              hint="The portable part of your profile — this is what lets the agent help with something you have never bought before."
            >
              <div className="grid gap-4 sm:grid-cols-[260px_1fr] sm:items-center">
                <QualityRadar qualities={likes.qualities} />
                <PreferenceBars items={likes.qualities} />
              </div>
            </ChartRow>
          ) : (
            <PreferenceRow label="Qualities" items={likes.qualities} />
          )}

          <PreferenceRow label="Colours" items={likes.colours} />
          <PreferenceRow label="Sizes ordered" items={likes.sizes} />
          <PreferenceRow label="Merchants" items={likes.merchants} />
        </CardBody>
      </Card>

      {hasDislikes ? (
        <Card>
          <CardBody className="space-y-5">
            <h2 className="text-sm font-semibold">What has not worked out</h2>
            <p className="-mt-3 text-sm text-muted-foreground">
              From reviews you rated poorly and orders you cancelled.
            </p>
            <ChartRow label="Brands" items={dislikes.brands}>
              <PreferenceBars items={dislikes.brands} tone="negative" />
            </ChartRow>
            <ChartRow label="Categories" items={dislikes.categories}>
              <PreferenceBars items={dislikes.categories} tone="negative" />
            </ChartRow>
            <ChartRow label="Qualities" items={dislikes.qualities}>
              <PreferenceBars items={dislikes.qualities} tone="negative" />
            </ChartRow>
          </CardBody>
        </Card>
      ) : null}

      {knowledge.budget ? (
        <Card>
          <CardBody className="space-y-1">
            <h2 className="text-sm font-semibold">What you usually spend</h2>
            <p className="tabular text-2xl font-semibold">
              {rupees(knowledge.budget.medianMinor)} <span className="text-sm font-normal text-muted-foreground">per item, typically</span>
            </p>
            <div className="pt-2">
              <SpendRange budget={knowledge.budget} />
            </div>
          </CardBody>
        </Card>
      ) : null}

      {knowledge.recentSearches.length > 0 ? (
        <Card>
          <CardBody className="space-y-2">
            <h2 className="text-sm font-semibold">Recently searched</h2>
            <div className="flex flex-wrap gap-1.5">
              {knowledge.recentSearches.map((s) => (
                <Badge key={s} tone="neutral">
                  {s}
                </Badge>
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardBody className="space-y-3">
          <h2 className="text-sm font-semibold">Your control over this</h2>
          <p className="text-sm text-muted-foreground">
            Clearing removes the browsing half — searches, filters and products you opened. Your
            orders and reviews stay, because they are records of real transactions with merchants
            rather than preferences we inferred, and deleting them would damage your own order
            history. Preferences only ever nudge the ranking between close options; nothing is ever
            hidden from you because of them.
          </p>
          {message ? <Alert tone="success">{message}</Alert> : null}
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await clearBrowsingSignalsAction();
                setMessage(result.message);
              })
            }
          >
            <Trash2 className="size-3.5" />
            {pending ? "Clearing…" : "Clear browsing history"}
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}

/** A labelled slot for a chart, matching `PreferenceRow`'s heading treatment. */
function ChartRow({
  label,
  hint,
  items,
  children,
}: {
  label: string;
  hint?: string;
  /** The rows the chart will draw — an empty set renders nothing at all. */
  items: Preference[];
  children: React.ReactNode;
}) {
  // A heading over an empty chart reads as a rendering failure. The charts
  // themselves already return null; the label has to go with them.
  if (items.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</p>
      {hint ? <p className="text-xs text-subtle">{hint}</p> : null}
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular text-xl font-semibold">{value}</dd>
    </div>
  );
}

/**
 * Confidence is shown as a word, never as colour alone, and the product count
 * is spelled out — "3 products" is the actual reason a preference is credible,
 * and it is more useful to the reader than any score would be.
 */
function PreferenceRow({
  label,
  items,
  hint,
  negative,
}: {
  label: string;
  items: Preference[];
  hint?: string;
  negative?: boolean;
}) {
  if (items.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</p>
      {hint ? <p className="text-xs text-subtle">{hint}</p> : null}
      <ul className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <li
            key={item.value}
            className={
              "flex items-baseline gap-1.5 rounded-lg border px-2.5 py-1 text-sm " +
              (negative ? "border-danger/40" : "border-border")
            }
          >
            <span className="font-medium">{humanise(item.value)}</span>
            <span className="text-xs text-subtle">
              {item.confidence} · {item.products} product{item.products === 1 ? "" : "s"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Quality keys arrive camelCased from the catalogue's own attributes. */
function humanise(value: string): string {
  const spaced = value.replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function rupees(minor: number): string {
  return `₹${Math.round(minor / 100).toLocaleString("en-IN")}`;
}
