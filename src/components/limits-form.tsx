"use client";

import { useActionState } from "react";
import { Alert, Button, Card, CardBody, Field, Input } from "@/components/ui";
import { updateLimitsAction } from "@/server/policy/actions";

type State = { ok?: boolean; message?: string; error?: string } | null;

export function LimitsForm({
  defaults,
}: {
  defaults: {
    maxOrderValue: number;
    maxDailySpend: number;
    maxItemsPerOrder: number;
    requireApprovalAbove: number;
  };
}) {
  const [state, action, pending] = useActionState<State, FormData>(updateLimitsAction, null);

  return (
    <Card>
      <CardBody>
        <form action={action} className="space-y-4">
          {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
          {state?.ok ? <Alert tone="success">{state.message}</Alert> : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Maximum per order (₹)">
              <Input name="maxOrderValue" type="number" min="1" defaultValue={defaults.maxOrderValue} />
            </Field>
            <Field label="Maximum per day (₹)">
              <Input name="maxDailySpend" type="number" min="1" defaultValue={defaults.maxDailySpend} />
            </Field>
            <Field label="Maximum items per order">
              <Input name="maxItemsPerOrder" type="number" min="1" defaultValue={defaults.maxItemsPerOrder} />
            </Field>
            <Field
              label="Auto-approve below (₹)"
              hint="0 means every payment needs your explicit authorization — the recommended setting."
            >
              <Input
                name="requireApprovalAbove"
                type="number"
                min="0"
                defaultValue={defaults.requireApprovalAbove}
              />
            </Field>
          </div>

          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save limits"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
