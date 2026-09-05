"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Card, CardBody, CardHeader, CardTitle, Field, Input, Select, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  createSupportThreadAction,
  replyToThreadAction,
  resolveThreadAction,
} from "@/server/support/actions";

type State = { ok?: boolean; message?: string; error?: string } | null;

const TOPICS = [
  { value: "order", label: "Where is my order?" },
  { value: "delivery", label: "Delivery problem" },
  { value: "return", label: "Return or exchange" },
  { value: "product", label: "Question about the product" },
  { value: "payment", label: "Payment or refund" },
  { value: "other", label: "Something else" },
];

export function NewThreadForm({
  orders,
}: {
  orders: Array<{ id: string; orderNumber: string; merchantId: string; merchantName: string }>;
}) {
  const [state, action, pending] = useActionState<State, FormData>(createSupportThreadAction, null);
  const [orderId, setOrderId] = useState(orders[0]?.id ?? "");

  const selected = orders.find((o) => o.id === orderId);

  if (orders.length === 0) {
    return (
      <Card>
        <CardBody>
          <p className="text-sm text-muted-foreground">
            You can message a merchant once you have ordered from them — that way your question
            arrives with the order it is about.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ask a merchant</CardTitle>
      </CardHeader>
      <CardBody>
        {/* The action revalidates /support server-side, so the list refreshes itself. */}
        <form action={action} className="space-y-4">
          {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
          {state?.ok ? <Alert tone="success">{state.message}</Alert> : null}

          <Field label="About which order?">
            <Select
              name="orderId"
              value={orderId}
              onChange={(event) => setOrderId(event.target.value)}
            >
              {orders.map((order) => (
                <option key={order.id} value={order.id}>
                  {order.orderNumber} — {order.merchantName}
                </option>
              ))}
            </Select>
          </Field>

          {/* The merchant is derived from the order, never chosen freely. */}
          <input type="hidden" name="merchantId" value={selected?.merchantId ?? ""} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Topic">
              <Select name="topic" defaultValue="order">
                {TOPICS.map((topic) => (
                  <option key={topic.value} value={topic.value}>
                    {topic.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Subject">
              <Input name="subject" required placeholder="Shoes arrived in the wrong size" />
            </Field>
          </div>

          <Field label="Your message">
            <Textarea
              name="message"
              rows={4}
              required
              placeholder="Tell the merchant what happened, and what you would like them to do."
            />
          </Field>

          <p className="text-xs text-subtle">
            This goes directly to {selected?.merchantName ?? "the merchant"}, not to a platform
            helpdesk — they are the only ones who can act on it.
          </p>

          <Button type="submit" disabled={pending}>
            {pending ? "Sending…" : "Send to merchant"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

export function ThreadConversation({
  threadId,
  status,
  messages,
  viewerRole,
}: {
  threadId: string;
  status: string;
  messages: Array<{ id: string; senderRole: string; body: string; createdAt: string }>;
  viewerRole: "customer" | "merchant";
}) {
  const [state, action, pending] = useActionState<State, FormData>(replyToThreadAction, null);
  const [resolving, startResolving] = useTransition();
  const router = useRouter();

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {messages.map((message) => {
          const mine = message.senderRole === viewerRole;
          return (
            <li
              key={message.id}
              className={cn("flex", mine ? "justify-end" : "justify-start")}
            >
              <div
                className={cn(
                  "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                  mine
                    ? "bg-primary text-primary-foreground"
                    : "border border-border bg-surface-2 text-foreground",
                )}
              >
                <p className="whitespace-pre-wrap">{message.body}</p>
                <p
                  className={cn(
                    "mt-1 text-[11px]",
                    mine ? "text-primary-foreground/70" : "text-subtle",
                  )}
                >
                  {message.senderRole === "merchant" ? "Merchant" : "Customer"} ·{" "}
                  {new Date(message.createdAt).toLocaleString("en-IN", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>
            </li>
          );
        })}
      </ul>

      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}

      {status === "resolved" ? (
        <Alert tone="success">This conversation is marked resolved.</Alert>
      ) : (
        <form action={action} className="space-y-2">
          <input type="hidden" name="threadId" value={threadId} />
          <Textarea
            name="body"
            rows={3}
            required
            placeholder={viewerRole === "merchant" ? "Reply to your customer…" : "Add to your message…"}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Sending…" : "Send reply"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={resolving}
              onClick={() =>
                startResolving(async () => {
                  await resolveThreadAction(threadId);
                  router.refresh();
                })
              }
            >
              Mark resolved
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * Whose turn it is, worded for whoever is reading.
 *
 * The same `open` thread is "awaiting merchant" to a shopper and "needs your
 * reply" to the merchant, and only the second of those tells the person looking
 * at it that they have something to do. A status label written from one side
 * only is half a label.
 */
export function StatusBadge({
  status,
  viewer = "customer",
}: {
  status: string;
  viewer?: "customer" | "merchant";
}) {
  const map: Record<
    string,
    { tone: "info" | "warning" | "success" | "neutral"; label: string }
  > =
    viewer === "merchant"
      ? {
          open: { tone: "warning", label: "Needs your reply" },
          awaiting_customer: { tone: "info", label: "Awaiting the shopper" },
          answered: { tone: "info", label: "You replied" },
          resolved: { tone: "success", label: "Resolved" },
        }
      : {
          open: { tone: "warning", label: "Awaiting merchant" },
          awaiting_customer: { tone: "info", label: "Awaiting you" },
          answered: { tone: "info", label: "Merchant replied" },
          resolved: { tone: "success", label: "Resolved" },
        };
  const entry = map[status] ?? { tone: "neutral" as const, label: status };
  return <Badge tone={entry.tone}>{entry.label}</Badge>;
}
