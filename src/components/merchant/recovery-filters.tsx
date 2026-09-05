"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Search, X } from "lucide-react";
import { Button, Input, Select } from "@/components/ui";
import { formatMoney, toMajor, toMinor } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * Narrowing the recovery board.
 *
 * Filters live in the URL, like browse: a merchant who has found the view they
 * want can keep it, share it with whoever handles escalations, and get back to
 * it with the back button. It also keeps the server the single place that
 * decides what matches, so the count in the header and the rows beneath it
 * cannot disagree.
 */
const WINDOWS = [
  { value: "", label: "Any time" },
  { value: "24", label: "Last 24 hours" },
  { value: "72", label: "Last 3 days" },
  { value: "168", label: "Last 7 days" },
  { value: "720", label: "Last 30 days" },
];

const STATES = [
  { value: "", label: "Any status" },
  { value: "awaiting_approval", label: "Needs approval" },
  { value: "escalated", label: "Escalated to me" },
  { value: "verifying", label: "Contacted — waiting" },
  { value: "diagnosed", label: "Ready to work" },
  { value: "recovered", label: "Recovered" },
  { value: "stopped", label: "Stopped" },
];

export function RecoveryFilters({
  shown,
  atRiskMinor,
  recoveredMinor,
}: {
  shown: number;
  atRiskMinor: number;
  recoveredMinor: number;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const value = (key: string) => params.get(key) ?? "";
  const [query, setQuery] = useState(value("q"));
  const [min, setMin] = useState(value("min") ? String(toMajor(Number(value("min")))) : "");

  // The URL is the source of truth: a Clear or a back button must be reflected
  // in the box, which holds its own draft between submissions.
  const urlQuery = params.get("q") ?? "";
  useEffect(() => setQuery(urlQuery), [urlQuery]);

  const apply = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params.toString());
    mutate(next);
    startTransition(() => router.push(`/merchant/recovery?${next.toString()}`, { scroll: false }));
  };

  const set = (key: string, v: string) =>
    apply((next) => (v ? next.set(key, v) : next.delete(key)));

  const active = ["q", "min", "within", "state"].filter((k) => params.get(k)).length;

  return (
    <div className={cn("space-y-3", pending && "opacity-60")} aria-busy={pending}>
      <div className="flex flex-wrap items-end gap-2">
        <form
          className="flex min-w-56 flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            set("q", query.trim());
          }}
        >
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Shopper name, email or order number"
              aria-label="Find a case by shopper or order"
              className="h-9 pl-9"
            />
          </div>
          <Button type="submit" size="sm" variant="secondary">
            Find
          </Button>
        </form>

        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            // Entered and read in rupees; the URL and the database stay in paise.
            set("min", min ? String(toMinor(Number(min))) : "");
          }}
        >
          <Input
            value={min}
            onChange={(e) => setMin(e.target.value)}
            type="number"
            min={0}
            inputMode="numeric"
            placeholder="Min ₹"
            aria-label="Minimum amount at risk, in rupees"
            className="h-9 w-28"
          />
          <Button type="submit" size="sm" variant="secondary">
            Go
          </Button>
        </form>

        <Select
          value={value("within")}
          onChange={(e) => set("within", e.target.value)}
          aria-label="Detected within"
          className="h-9 w-auto"
        >
          {WINDOWS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </Select>

        <Select
          value={value("state")}
          onChange={(e) => set("state", e.target.value)}
          aria-label="Case status"
          className="h-9 w-auto"
        >
          {STATES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>

        {active > 0 ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => startTransition(() => router.push("/merchant/recovery"))}
          >
            <X className="size-3.5" />
            Clear {active}
          </Button>
        ) : null}
      </div>

      {/*
        * Totals for what is ON SCREEN, not for the whole merchant.
        *
        * A merchant who has filtered to "over ₹10,000 in the last day" wants to
        * know what that is worth; showing the unfiltered total beside a
        * filtered list invites reading one as the other.
        */}
      <p className="text-xs text-muted-foreground" aria-live="polite">
        Showing <span className="tabular font-medium text-foreground">{shown}</span> case
        {shown === 1 ? "" : "s"}
        {active > 0 ? " matching these filters" : ""} —{" "}
        <span className="tabular font-medium text-foreground">{formatMoney(atRiskMinor)}</span> still
        at risk
        {recoveredMinor > 0 ? (
          <>
            , <span className="tabular font-medium text-success">{formatMoney(recoveredMinor)}</span>{" "}
            recovered
          </>
        ) : null}
      </p>
    </div>
  );
}
