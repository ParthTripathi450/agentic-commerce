"use client";

import { useActionState } from "react";
import { Alert, Button, Card, CardBody, CardHeader, CardTitle, Field, Input, Textarea } from "@/components/ui";
import {
  updateAgentLimitsAction,
  updatePoliciesAction,
  updateStoreProfileAction,
} from "@/server/merchant/settings-actions";

type State = { ok?: boolean; message?: string; error?: string } | null;

function Feedback({ state }: { state: State }) {
  if (state?.error) return <Alert tone="danger">{state.error}</Alert>;
  if (state?.ok) return <Alert tone="success">{state.message}</Alert>;
  return null;
}

export function StoreProfileForm({
  merchant,
}: {
  merchant: { name: string; description: string | null; supportEmail: string | null; slug: string };
}) {
  const [state, action, pending] = useActionState<State, FormData>(updateStoreProfileAction, null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Store profile</CardTitle>
      </CardHeader>
      <CardBody>
        <form action={action} className="space-y-4">
          <Feedback state={state} />
          <Field label="Store name">
            <Input name="name" defaultValue={merchant.name} required />
          </Field>
          <Field
            label="Description"
            hint="Shown in your UCP manifest and used when agents compare merchants."
          >
            <Textarea name="description" rows={3} defaultValue={merchant.description ?? ""} />
          </Field>
          <Field label="Support email">
            <Input name="supportEmail" type="email" defaultValue={merchant.supportEmail ?? ""} />
          </Field>
          <p className="text-xs text-subtle">
            Storefront slug <span className="font-mono">/{merchant.slug}</span> is fixed — agents
            and protocol endpoints reference it.
          </p>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save profile"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

export function PoliciesForm({
  policies,
}: {
  policies: {
    returnsAccepted: boolean;
    returnWindowDays: number;
    returnPolicyText: string;
    shippingPolicyText: string;
    standardDeliveryDays: number;
    flatShipping: number;
    freeShippingAbove: number | "";
    warrantyText: string;
    cancellationText: string;
  };
}) {
  const [state, action, pending] = useActionState<State, FormData>(updatePoliciesAction, null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Policies</CardTitle>
      </CardHeader>
      <CardBody>
        <form action={action} className="space-y-4">
          <Feedback state={state} />

          <Alert tone="info">
            Return window and delivery time are <strong>scored criteria</strong> when agents rank
            your products against other merchants — not just text. Saving re-indexes your catalog.
          </Alert>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="returnsAccepted"
                defaultChecked={policies.returnsAccepted}
                className="accent-[var(--primary)]"
              />
              Accept returns
            </label>
            <Field label="Return window (days)">
              <Input name="returnWindowDays" type="number" min="0" max="365" defaultValue={policies.returnWindowDays} />
            </Field>
          </div>

          <Field label="Return policy">
            <Textarea name="returnPolicyText" rows={2} defaultValue={policies.returnPolicyText} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Delivery time (days)">
              <Input name="standardDeliveryDays" type="number" min="1" max="90" defaultValue={policies.standardDeliveryDays} />
            </Field>
            <Field label="Flat shipping (₹)">
              <Input name="flatShipping" type="number" step="0.01" min="0" defaultValue={policies.flatShipping} />
            </Field>
            <Field label="Free shipping above (₹)" hint="Blank for never">
              <Input name="freeShippingAbove" type="number" step="0.01" min="0" defaultValue={policies.freeShippingAbove} />
            </Field>
          </div>

          <Field label="Shipping policy">
            <Textarea name="shippingPolicyText" rows={2} defaultValue={policies.shippingPolicyText} />
          </Field>
          <Field label="Warranty">
            <Textarea name="warrantyText" rows={2} defaultValue={policies.warrantyText} />
          </Field>
          <Field label="Cancellation">
            <Textarea name="cancellationText" rows={2} defaultValue={policies.cancellationText} />
          </Field>

          <Button type="submit" disabled={pending}>
            {pending ? "Saving and re-indexing…" : "Save policies"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

export function AgentLimitsForm({
  limits,
}: {
  limits: {
    maxPriceChangePct: number;
    maxDiscountPct: number;
    maxRestockUnits: number;
    maxRestockCost: number;
    requireApprovalForAll: boolean;
  };
}) {
  const [state, action, pending] = useActionState<State, FormData>(updateAgentLimitsAction, null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>What your agent may do</CardTitle>
      </CardHeader>
      <CardBody>
        <form action={action} className="space-y-4">
          <Feedback state={state} />
          <p className="text-sm text-muted-foreground">
            Hard bounds on the merchant agent. Anything beyond these is refused outright, with the
            limit that stopped it recorded in your activity log.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Max price change (%)">
              <Input name="maxPriceChangePct" type="number" step="0.1" min="0" max="90" defaultValue={limits.maxPriceChangePct} />
            </Field>
            <Field label="Max discount (%)">
              <Input name="maxDiscountPct" type="number" step="0.1" min="0" max="90" defaultValue={limits.maxDiscountPct} />
            </Field>
            <Field label="Max restock (units)">
              <Input name="maxRestockUnits" type="number" min="0" defaultValue={limits.maxRestockUnits} />
            </Field>
            <Field label="Max restock cost (₹)">
              <Input name="maxRestockCost" type="number" step="1" min="0" defaultValue={limits.maxRestockCost} />
            </Field>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="requireApprovalForAll"
              defaultChecked={limits.requireApprovalForAll}
              className="mt-0.5 accent-[var(--primary)]"
            />
            <span>
              Ask me before every action
              <span className="block text-xs text-muted-foreground">
                Recommended. Unchecked, actions inside the bounds above execute without a prompt —
                still logged, still bounded, but not individually approved.
              </span>
            </span>
          </label>

          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save limits"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
