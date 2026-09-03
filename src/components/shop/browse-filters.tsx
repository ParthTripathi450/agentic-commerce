"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Search, X } from "lucide-react";
import { Button, Input, Select } from "@/components/ui";
import { formatMoney, toMajor, toMinor } from "@/lib/money";
import { cn } from "@/lib/utils";
import { BROWSE_SORTS, type BrowseResult } from "@/lib/browse";

/**
 * Every filter lives in the URL, never in component state.
 *
 * A filtered view is then something you can share, bookmark and reach with the
 * back button — and the server stays the single place that decides what matches,
 * so the count in the heading and the rows in the grid can never disagree.
 */
export function BrowseFilters({
  result,
  merchants,
}: {
  result: BrowseResult;
  merchants: { id: string; name: string }[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const selected = (key: string) => params.getAll(key);
  const single = (key: string) => params.get(key) ?? "";

  const apply = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params.toString());
    mutate(next);
    // Any change to what matches invalidates the page number — staying on
    // page 4 of a set that now has two pages shows an empty grid.
    next.delete("page");
    startTransition(() => router.push(`/browse?${next.toString()}`, { scroll: false }));
  };

  const toggle = (key: string, value: string) =>
    apply((next) => {
      const current = next.getAll(key);
      next.delete(key);
      for (const v of current) if (v !== value) next.append(key, v);
      if (!current.includes(value)) next.append(key, value);
    });

  const set = (key: string, value: string) =>
    apply((next) => (value ? next.set(key, value) : next.delete(key)));

  const activeCount =
    selected("category").length +
    selected("brand").length +
    ["q", "merchant", "min", "max", "rating"].filter((k) => params.get(k)).length +
    (params.get("stock") === "any" ? 1 : 0);

  return (
    <aside
      className={cn("space-y-6 lg:sticky lg:top-6 lg:self-start", pending && "opacity-60")}
      aria-busy={pending}
    >
      <SearchBox initial={single("q")} onSearch={(q) => set("q", q)} />

      <Group label="Sort by">
        <Select value={single("sort") || "relevance"} onChange={(e) => set("sort", e.target.value)}>
          {BROWSE_SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </Group>

      {result.priceBands.length > 0 ? (
        <Group label="Price">
          <div className="flex flex-wrap gap-1.5">
            {result.priceBands.map((band) => {
              const on =
                single("min") === String(band.minMinor) &&
                single("max") === String(band.maxMinor ?? "");
              return (
                <button
                  key={`${band.minMinor}-${band.maxMinor}`}
                  type="button"
                  onClick={() =>
                    apply((next) => {
                      if (on) {
                        next.delete("min");
                        next.delete("max");
                        return;
                      }
                      next.set("min", String(band.minMinor));
                      if (band.maxMinor == null) next.delete("max");
                      else next.set("max", String(band.maxMinor));
                    })
                  }
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs transition-colors",
                    on
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border hover:border-primary hover:text-primary",
                  )}
                >
                  {bandLabel(band)}{" "}
                  <span className={cn("tabular", on ? "opacity-80" : "text-subtle")}>
                    {band.count}
                  </span>
                </button>
              );
            })}
          </div>
          <PriceRange
            min={single("min")}
            max={single("max")}
            onApply={(min, max) =>
              apply((next) => {
                if (min) next.set("min", min);
                else next.delete("min");
                if (max) next.set("max", max);
                else next.delete("max");
              })
            }
          />
        </Group>
      ) : null}

      {result.categories.length > 0 ? (
        <FacetGroup
          label="Category"
          options={result.categories}
          chosen={selected("category")}
          onToggle={(v) => toggle("category", v)}
        />
      ) : null}

      {result.brands.length > 0 ? (
        <FacetGroup
          label="Brand"
          options={result.brands}
          chosen={selected("brand")}
          onToggle={(v) => toggle("brand", v)}
        />
      ) : null}

      <Group label="Rating">
        <Select value={single("rating")} onChange={(e) => set("rating", e.target.value)}>
          <option value="">Any rating</option>
          <option value="4500">4.5★ and up</option>
          <option value="4000">4★ and up</option>
          <option value="3000">3★ and up</option>
        </Select>
      </Group>

      <Group label="Merchant">
        <Select value={single("merchant")} onChange={(e) => set("merchant", e.target.value)}>
          <option value="">Every merchant</option>
          {merchants.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
      </Group>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={params.get("stock") !== "any"}
          onChange={(e) => set("stock", e.target.checked ? "" : "any")}
        />
        In stock only
      </label>

      {activeCount > 0 ? (
        <Button variant="secondary" size="sm" onClick={() => startTransition(() => router.push("/browse"))}>
          <X className="size-3.5" />
          Clear {activeCount} filter{activeCount === 1 ? "" : "s"}
        </Button>
      ) : null}
    </aside>
  );
}

/**
 * Bands abut exactly, so each one starts a single paise above the last — which
 * is correct as a filter and reads as "₹4,299.01" as a label. The lower bound
 * is rounded up to the rupee for display only; the paise-exact value is what
 * goes in the URL, so the label rounds without the band shifting.
 */
function bandLabel(band: { minMinor: number; maxMinor: number | null }) {
  const from = formatMoney(Math.ceil(band.minMinor / 100) * 100);
  if (band.minMinor === 0) return `Under ${formatMoney(band.maxMinor ?? 0)}`;
  if (band.maxMinor == null) return `${from}+`;
  return `${from} – ${formatMoney(band.maxMinor)}`;
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{label}</p>
      {children}
    </div>
  );
}

/**
 * Typing is local; only submitting changes the URL. Pushing a route on every
 * keystroke re-runs five queries per character and fights the cursor.
 */
function SearchBox({ initial, onSearch }: { initial: string; onSearch: (q: string) => void }) {
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(value.trim());
      }}
      className="flex gap-2"
    >
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Search all products"
          aria-label="Search all products"
          className="pl-9"
        />
      </div>
      <Button type="submit" size="sm">
        Search
      </Button>
    </form>
  );
}

/** Prices are entered and read in rupees; the URL and the DB stay in paise. */
function PriceRange({
  min,
  max,
  onApply,
}: {
  min: string;
  max: string;
  onApply: (min: string, max: string) => void;
}) {
  const asMajor = (v: string) => (v ? String(toMajor(Number(v))) : "");
  const [lo, setLo] = useState(asMajor(min));
  const [hi, setHi] = useState(asMajor(max));

  useEffect(() => setLo(asMajor(min)), [min]);
  useEffect(() => setHi(asMajor(max)), [max]);

  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        onApply(
          lo ? String(toMinor(Number(lo))) : "",
          hi ? String(toMinor(Number(hi))) : "",
        );
      }}
    >
      <Input
        type="number"
        min={0}
        inputMode="numeric"
        value={lo}
        onChange={(e) => setLo(e.target.value)}
        placeholder="Min ₹"
        aria-label="Minimum price in rupees"
        className="h-8 text-xs"
      />
      <span className="text-xs text-subtle">to</span>
      <Input
        type="number"
        min={0}
        inputMode="numeric"
        value={hi}
        onChange={(e) => setHi(e.target.value)}
        placeholder="Max ₹"
        aria-label="Maximum price in rupees"
        className="h-8 text-xs"
      />
      <Button type="submit" size="sm" variant="secondary" className="h-8 px-2 text-xs">
        Go
      </Button>
    </form>
  );
}

/**
 * Counts are what a facet is FOR: they say how many results ticking this box
 * would leave, so the shopper can tell a productive narrowing from a dead end
 * before clicking it. A long list scrolls in place rather than pushing the rest
 * of the rail off screen.
 */
function FacetGroup({
  label,
  options,
  chosen,
  onToggle,
}: {
  label: string;
  options: { value: string; count: number }[];
  chosen: string[];
  onToggle: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? options : options.slice(0, 8);

  return (
    <Group label={label}>
      <ul className={cn("space-y-1", expanded && "max-h-72 overflow-y-auto pr-1")}>
        {shown.map((option) => (
          <li key={option.value}>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 shrink-0 accent-primary"
                checked={chosen.includes(option.value)}
                onChange={() => onToggle(option.value)}
              />
              <span className="min-w-0 flex-1 truncate">{option.value}</span>
              <span className="tabular shrink-0 text-xs text-subtle">{option.count}</span>
            </label>
          </li>
        ))}
      </ul>
      {options.length > 8 ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-primary underline underline-offset-4"
        >
          {expanded ? "Show fewer" : `Show all ${options.length}`}
        </button>
      ) : null}
    </Group>
  );
}
