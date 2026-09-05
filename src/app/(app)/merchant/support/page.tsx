import Link from "next/link";
import { Badge, Card, CardBody, EmptyState } from "@/components/ui";
import { PageHeader } from "@/components/page-header";
import { StatusBadge, ThreadConversation } from "@/components/support/support-forms";
import { requireMerchant } from "@/lib/session";
import { getMerchantThreads, getThreadMessages } from "@/server/support/queries";

export default async function MerchantSupportPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string }>;
}) {
  await requireMerchant();
  const { thread: threadId } = await searchParams;

  const threads = await getMerchantThreads();
  const open = threadId ? await getThreadMessages(threadId) : null;
  const waiting = threads.filter((t) => t.status === "open").length;

  return (
    <div>
      <PageHeader
        title="Customer queries"
        description="Questions from people who bought from you. Answering quickly is the cheapest thing you can do for your fulfilment rate — which agents score you on."
        actions={waiting > 0 ? <Badge tone="warning">{waiting} awaiting your reply</Badge> : undefined}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <Card className="h-fit">
          <CardBody className="px-0 py-0">
            {threads.length === 0 ? (
              <div className="p-5">
                <EmptyState title="No customer queries yet" />
              </div>
            ) : (
              <ul>
                {threads.map((t) => (
                  <li key={t.id} className="border-b border-border last:border-0">
                    <Link
                      href={`/merchant/support?thread=${t.id}`}
                      className={`block px-5 py-3 transition-colors hover:bg-muted ${
                        t.id === threadId ? "bg-muted" : ""
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{t.subject}</span>
                        <StatusBadge status={t.status} viewer="merchant" />
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {t.topic}
                        {t.orderNumber ? ` · ${t.orderNumber}` : ""} ·{" "}
                        {new Date(t.lastMessageAt).toLocaleDateString("en-IN", {
                          day: "numeric",
                          month: "short",
                        })}
                      </p>
                      <p className="mt-1 truncate text-xs text-subtle">{t.lastMessage}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card className="h-fit">
          <CardBody>
            {open ? (
              <>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                  <p className="text-sm font-semibold">{open.thread.subject}</p>
                  <StatusBadge status={open.thread.status} viewer="merchant" />
                </div>
                <ThreadConversation
                  threadId={open.thread.id}
                  status={open.thread.status}
                  viewerRole="merchant"
                  messages={open.messages.map((m) => ({
                    id: m.id,
                    senderRole: m.senderRole,
                    body: m.body,
                    createdAt: m.createdAt.toISOString(),
                  }))}
                />
              </>
            ) : (
              <EmptyState title="Select a query to reply" />
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
