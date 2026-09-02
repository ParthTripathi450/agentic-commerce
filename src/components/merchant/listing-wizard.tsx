"use client";

import { useActionState, useState, useTransition } from "react";
import { ArrowLeft, Check, Sparkles } from "lucide-react";
import { Alert, Badge, Button, Card, CardBody, CardHeader, CardTitle, Field, Input, Select, Textarea } from "@/components/ui";
import { TagEditor } from "./tag-editor";
import {
  createAssistedProductAction,
  generateDraftAction,
  suggestBrandsAction,
  suggestProductsAction,
} from "@/server/agents/merchant/listing-actions";
import { cn } from "@/lib/utils";

/**
 * Assisted listing wizard.
 *
 * Each step offers suggestions and a manual escape hatch, because the agent
 * will not know every niche brand or product — and a merchant blocked by a
 * missing suggestion would be worse off than with a plain form.
 */

type Suggestion = { name: string; source: "marketplace" | "suggested"; productCount?: number };

type Draft = {
  title: string;
  description: string;
  attributes: Record<string, unknown>;
  tags: string[];
  variantAxes: Record<string, string[]>;
  degraded: boolean;
};

export function ListingWizard({ categories }: { categories: string[] }) {
  const [step, setStep] = useState(1);
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);

  const [itemQuery, setItemQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [brands, setBrands] = useState<Suggestion[]>([]);
  const [brand, setBrand] = useState("");
  const [productNames, setProductNames] = useState<Suggestion[]>([]);
  const [, setProductName] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [aiTags, setAiTags] = useState<string[]>([]);
  /** Every option the agent proposed, so deselecting one is reversible. */
  const [allAxes, setAllAxes] = useState<Record<string, string[]>>({});

  const [state, action, submitting] = useActionState<{ error?: string } | null, FormData>(
    createAssistedProductAction,
    null,
  );

  const findBrands = () =>
    start(async () => {
      setNotice(null);
      const result = await suggestBrandsAction(itemQuery);
      setBrands(result.brands);
      setCategory(result.category);
      if (result.brands.length === 0) {
        setNotice("No brands found for that. Type the brand name yourself below.");
      } else if (result.degraded) {
        setNotice("Suggestions are limited right now — only brands already on this marketplace.");
      }
      setStep(2);
    });

  const findProducts = (chosen: string) =>
    start(async () => {
      setNotice(null);
      setBrand(chosen);
      const result = await suggestProductsAction(chosen, category);
      setProductNames(result.products);
      if (result.products.length === 0) {
        setNotice(`No known products for ${chosen}. Type the product name yourself.`);
      }
      setStep(3);
    });

  const fetchDetails = (chosen: string) =>
    start(async () => {
      setNotice(null);
      setProductName(chosen);
      const result = await generateDraftAction({ brand, productName: chosen, category });
      setDraft(result as Draft);
      setAiTags(result.tags);
      setAllAxes(result.variantAxes ?? {});
      if (result.degraded || !result.description) {
        setNotice("Could not fetch details automatically. Fill them in below — everything is editable.");
      }
      setStep(4);
    });

  return (
    <div className="space-y-4">
      <Steps current={step} />

      {notice ? <Alert tone="info">{notice}</Alert> : null}
      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}

      {step === 1 ? (
        <Card data-static="true">
          <CardHeader>
            <CardTitle>What are you selling?</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            <Field label="Item" hint="Plain words are fine — 'running shoes', 'espresso machine'.">
              <Input
                value={itemQuery}
                onChange={(e) => setItemQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && findBrands()}
                placeholder="running shoes"
                autoFocus
              />
            </Field>
            <Button onClick={findBrands} disabled={pending || itemQuery.trim().length < 2}>
              <Sparkles className="size-4" />
              {pending ? "Finding brands…" : "Find brands"}
            </Button>
          </CardBody>
        </Card>
      ) : null}

      {step === 2 ? (
        <PickerStep
          title="Which brand?"
          suggestions={brands}
          manualLabel="Brand not listed? Type it"
          manualPlaceholder="Stride"
          pending={pending}
          onPick={findProducts}
          onBack={() => setStep(1)}
          footer={
            category ? (
              <p className="text-xs text-subtle">
                Listing under <span className="font-medium text-foreground">{category}</span>
              </p>
            ) : null
          }
        />
      ) : null}

      {step === 3 ? (
        <PickerStep
          title={`Which ${brand} product?`}
          suggestions={productNames}
          manualLabel="Not listed? Type the product name"
          manualPlaceholder="Velocity Run 3"
          pending={pending}
          onPick={fetchDetails}
          onBack={() => setStep(2)}
        />
      ) : null}

      {step === 4 && draft ? (
        <form action={action} className="space-y-4">
          <input type="hidden" name="attributesJson" value={JSON.stringify(draft.attributes)} />
          <input type="hidden" name="tagsJson" value={JSON.stringify(draft.tags)} />
          <input type="hidden" name="axesJson" value={JSON.stringify(draft.variantAxes)} />

          <Card data-static="true">
            <CardHeader>
              <CardTitle>The agent filled these in — check them</CardTitle>
            </CardHeader>
            <CardBody className="space-y-4">
              <Field label="Title">
                <Input name="title" defaultValue={draft.title} required />
              </Field>

              <Field label="Description" hint="What AI agents read. Concrete detail beats adjectives.">
                <Textarea name="description" rows={4} defaultValue={draft.description} />
              </Field>

              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Brand">
                  <Input name="brand" defaultValue={brand} />
                </Field>
                <Field label="Category">
                  <Input name="category" defaultValue={category ?? ""} required list="known-categories" />
                </Field>
                <Field label="Status">
                  <Select name="status" defaultValue="active">
                    <option value="active">Active</option>
                    <option value="draft">Draft</option>
                  </Select>
                </Field>
              </div>
              <datalist id="known-categories">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>

              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                  Specifications the agent fetched
                </p>
                {Object.keys(draft.attributes).length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    None found — add them from the product page after saving.
                  </p>
                ) : (
                  <dl className="grid gap-1 rounded-lg bg-surface-2 p-3 text-xs sm:grid-cols-2">
                    {Object.entries(draft.attributes).map(([key, value]) => (
                      <div key={key} className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">
                          {key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()}
                        </dt>
                        <dd className="font-medium">
                          {Array.isArray(value) ? value.join(", ") : String(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            </CardBody>
          </Card>

          <Card data-static="true">
            <CardHeader>
              <CardTitle>Search tags</CardTitle>
            </CardHeader>
            <CardBody>
              <TagEditor
                tags={draft.tags}
                aiProposed={aiTags}
                onChange={(tags) => setDraft({ ...draft, tags })}
              />
            </CardBody>
          </Card>

          <Card data-static="true">
            <CardHeader>
              <CardTitle>Options, price and stock</CardTitle>
            </CardHeader>
            <CardBody className="space-y-4">
              <AxisPicker
                allAxes={allAxes}
                selected={draft.variantAxes}
                onChange={(variantAxes) => setDraft({ ...draft, variantAxes })}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Price (₹)" hint="Applies to every variant; edit individually later.">
                  <Input name="price" type="number" step="0.01" min="1" required />
                </Field>
                <Field label="Stock per variant">
                  <Input name="quantity" type="number" min="0" defaultValue={0} required />
                </Field>
              </div>
            </CardBody>
          </Card>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="lg" disabled={submitting}>
              <Check className="size-4" />
              {submitting ? "Creating and indexing…" : "Create product"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setStep(3)}>
              <ArrowLeft className="size-4" />
              Back
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function Steps({ current }: { current: number }) {
  const labels = ["Item", "Brand", "Product", "Details"];
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs">
      {labels.map((label, index) => {
        const step = index + 1;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                "grid size-6 place-items-center rounded-full font-semibold",
                step < current && "bg-success-soft text-success",
                step === current && "bg-primary text-primary-foreground",
                step > current && "bg-muted text-muted-foreground",
              )}
            >
              {step < current ? "✓" : step}
            </span>
            <span className={cn(step === current ? "font-medium" : "text-muted-foreground")}>
              {label}
            </span>
            {step < labels.length ? <span className="text-subtle">→</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

function PickerStep({
  title,
  suggestions,
  manualLabel,
  manualPlaceholder,
  pending,
  onPick,
  onBack,
  footer,
}: {
  title: string;
  suggestions: Suggestion[];
  manualLabel: string;
  manualPlaceholder: string;
  pending: boolean;
  onPick: (value: string) => void;
  onBack: () => void;
  footer?: React.ReactNode;
}) {
  const [manual, setManual] = useState("");
  const onMarketplace = suggestions.filter((s) => s.source === "marketplace");
  const suggested = suggestions.filter((s) => s.source === "suggested");

  return (
    <Card data-static="true">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        {onMarketplace.length > 0 ? (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              Already on this marketplace
            </p>
            <div className="flex flex-wrap gap-2">
              {onMarketplace.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  disabled={pending}
                  onClick={() => onPick(s.name)}
                  className="rounded-lg border border-input bg-card px-3 py-2 text-sm transition-colors hover:bg-muted disabled:opacity-50"
                >
                  {s.name}
                  {s.productCount ? (
                    <span className="ml-1.5 text-xs text-subtle">{s.productCount}</span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {suggested.length > 0 ? (
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              Suggested
              <Badge tone="warning">unverified — confirm it is what you stock</Badge>
            </p>
            <div className="flex flex-wrap gap-2">
              {suggested.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  disabled={pending}
                  onClick={() => onPick(s.name)}
                  className="rounded-lg border border-dashed border-input px-3 py-2 text-sm transition-colors hover:bg-muted disabled:opacity-50"
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="border-t border-border pt-3">
          <Field label={manualLabel}>
            <div className="flex gap-2">
              <Input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && manual.trim()) {
                    e.preventDefault();
                    onPick(manual.trim());
                  }
                }}
                placeholder={manualPlaceholder}
              />
              <Button
                type="button"
                variant="secondary"
                disabled={pending || manual.trim().length < 1}
                onClick={() => onPick(manual.trim())}
              >
                Use this
              </Button>
            </div>
          </Field>
        </div>

        {footer}

        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" />
          Back
        </Button>
      </CardBody>
    </Card>
  );
}

/**
 * Lets the merchant keep only the option values they actually stock.
 *
 * The full option list and the selection are held separately: removing a value
 * from the list it is rendered from would make the choice irreversible.
 */
function AxisPicker({
  allAxes,
  selected,
  onChange,
}: {
  allAxes: Record<string, string[]>;
  selected: Record<string, string[]>;
  onChange: (next: Record<string, string[]>) => void;
}) {
  const entries = Object.entries(allAxes);
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No options for this product — a single variant will be created.
      </p>
    );
  }

  const total = entries.reduce(
    (n, [axis]) => n * Math.max((selected[axis] ?? []).length, 1),
    1,
  );

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Deselect anything you do not stock. One variant is created per combination.
      </p>
      {entries.map(([axis, values]) => (
        <div key={axis}>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground capitalize">{axis}</p>
          <div className="flex flex-wrap gap-1.5">
            {values.map((value) => {
              const on = (selected[axis] ?? []).includes(value);
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    onChange({
                      ...selected,
                      [axis]: on
                        ? (selected[axis] ?? []).filter((v) => v !== value)
                        : [...(selected[axis] ?? []), value],
                    })
                  }
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs transition-colors",
                    on
                      ? "border-primary bg-primary-soft text-accent-foreground"
                      : "border-input text-muted-foreground hover:bg-muted",
                  )}
                >
                  {value}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <p className={cn("text-xs", total > 24 ? "font-medium text-danger" : "text-subtle")}>
        {total} variant{total === 1 ? "" : "s"} will be created{total > 24 ? " — trim to 24 or fewer" : ""}.
      </p>
    </div>
  );
}
