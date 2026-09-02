"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CreditCard, ShieldCheck } from "lucide-react";
import { Alert, Badge, Button, Card, CardBody, CardHeader, CardTitle } from "@/components/ui";
import {
  enableTestPaymentMethodAction,
  removePaymentMethodAction,
} from "@/server/payments/actions";

/**
 * Saved payment method.
 *
 * There is no card-number field anywhere in this UI by design: enabling a
 * method generates fabricated display metadata on the server. Nothing here ever
 * handles a real credential.
 */
export function PaymentMethodCard({
  method,
}: {
  method: { id: string; description: string } | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <Card data-static="true">
      <CardHeader>
        <CardTitle>Payment method for agent purchases</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-sm text-muted-foreground">
          With a method on file, the agent can finish a purchase the moment you approve it —
          without you typing anything. It still cannot pay without that approval.
        </p>

        {message ? <Alert tone="success">{message}</Alert> : null}

        {method ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 p-3">
            <span className="flex items-center gap-2.5">
              <CreditCard className="size-5 text-muted-foreground" strokeWidth={1.75} />
              <span>
                <span className="block text-sm font-medium">{method.description}</span>
                <Badge tone="warning">fabricated test data — no real card</Badge>
              </span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await removePaymentMethodAction(method.id);
                  setMessage(r.message);
                  router.refresh();
                })
              }
            >
              Remove
            </Button>
          </div>
        ) : (
          <Button
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await enableTestPaymentMethodAction();
                setMessage(r.message);
                router.refresh();
              })
            }
          >
            <ShieldCheck className="size-4" />
            {pending ? "Setting up…" : "Enable a test payment method"}
          </Button>
        )}

        <p className="text-xs text-subtle">
          No card number is requested or stored — only a brand and last four digits, generated
          for display. Charges against it run through the mock gateway and move no money.
        </p>
      </CardBody>
    </Card>
  );
}
