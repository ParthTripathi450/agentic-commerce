"use client";

import { useState } from "react";
import { Check, MapPin, Plus } from "lucide-react";
import { Button, Field, Input } from "@/components/ui";
import { addAddressAction } from "@/server/commerce/address-actions";
import { cn } from "@/lib/utils";

export type PickableAddress = {
  id: string;
  label: string;
  recipient: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postcode: string;
  isDefault: boolean;
};

/**
 * Where is this going?
 *
 * The common answer is "the usual place", so that is what it shows — already
 * selected, with everything else one click away. Making a shopper re-pick an
 * address they have used ten times is friction with no information in it.
 *
 * The other addresses and the "somewhere else" form stay collapsed until asked
 * for, because a checkout that opens with an empty form invites abandoning it.
 */
export function AddressPicker({
  addresses,
  selectedId,
  onSelect,
}: {
  addresses: PickableAddress[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = addresses.find((a) => a.id === selectedId) ?? addresses[0] ?? null;
  const others = addresses.filter((a) => a.id !== selected?.id);

  async function saveNew(form: FormData) {
    setSaving(true);
    setError(null);
    const result = await addAddressAction(form);
    setSaving(false);
    if ("error" in result && result.error) return setError(result.error);
    if ("addressId" in result && result.addressId) {
      onSelect(result.addressId);
      setAdding(false);
      setExpanded(false);
    }
  }

  return (
    <div className="rounded-lg border border-border p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <MapPin className="size-3.5" aria-hidden />
        Delivering to
      </p>

      {selected ? (
        <p className="text-sm">
          <span className="font-medium">{selected.recipient}</span>
          {selected.label ? ` · ${selected.label}` : ""}
          <br />
          <span className="text-muted-foreground">
            {[selected.line1, selected.line2, `${selected.city}, ${selected.state} ${selected.postcode}`]
              .filter(Boolean)
              .join(", ")}
          </span>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          No address saved yet — add one so the merchant knows where to send this.
        </p>
      )}

      {!expanded && !adding ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 text-xs text-primary underline underline-offset-4 hover:text-primary/80"
        >
          {addresses.length > 1 ? "Deliver somewhere else" : "Use a different address"}
        </button>
      ) : null}

      {expanded && !adding ? (
        <div className="mt-3 space-y-2">
          {others.map((address) => (
            <button
              key={address.id}
              type="button"
              onClick={() => {
                onSelect(address.id);
                setExpanded(false);
              }}
              className={cn(
                "flex w-full items-start gap-2 rounded-lg border p-2.5 text-left text-sm transition-colors",
                "border-border hover:border-primary hover:bg-muted/40",
              )}
            >
              <Check className="mt-0.5 size-3.5 shrink-0 opacity-0" aria-hidden />
              <span>
                <span className="font-medium">{address.label}</span> — {address.recipient}
                <br />
                <span className="text-xs text-muted-foreground">
                  {address.line1}, {address.city} {address.postcode}
                </span>
              </span>
            </button>
          ))}

          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            Add a new address
          </Button>
        </div>
      ) : null}

      {adding ? (
        <form action={saveNew} className="mt-3 space-y-2.5">
          <div className="grid gap-2.5 sm:grid-cols-2">
            <Field label="Label">
              <Input name="label" placeholder="Office" className="h-9" />
            </Field>
            <Field label="Recipient">
              <Input name="recipient" required placeholder="Riya Sharma" className="h-9" />
            </Field>
          </div>
          <Field label="Street address">
            <Input name="line1" required placeholder="12 MG Road" className="h-9" />
          </Field>
          <Field label="Flat, floor, landmark">
            <Input name="line2" placeholder="Flat 4B" className="h-9" />
          </Field>
          <div className="grid gap-2.5 sm:grid-cols-3">
            <Field label="City">
              <Input name="city" required placeholder="Bengaluru" className="h-9" />
            </Field>
            <Field label="State">
              <Input name="state" required placeholder="Karnataka" className="h-9" />
            </Field>
            <Field label="Postcode">
              <Input name="postcode" required inputMode="numeric" placeholder="560001" className="h-9" />
            </Field>
          </div>
          {error ? <p className="text-xs text-danger">{error}</p> : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "Saving…" : "Deliver here"}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
