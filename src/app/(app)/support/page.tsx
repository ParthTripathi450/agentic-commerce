import Link from "next/link";
import { Card, CardBody, EmptyState } from "@/components/ui";
import { PageHeader } from "@/components/page-header";
import {
  NewThreadForm,
  StatusBadge,
  ThreadConversation,
} from "@/components/support/support-forms";
import { requireCustomer } from "@/lib/session";
import {
  getCustomerOrderOptions,
  getCustomerThreads,
  getThreadMessages,
} from "@/server/support/queries";

export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string }>;
}) {
  await requireCustomer();
  const { thread: threadId } = await searchParams;

  const [threads, orderOptions] = await Promise.all([
    getCustomerThreads(),
    getCustomerOrderOptions(),
  ]);

  const open = threadId ? await getThreadMessages(threadId) : null;

  return (
    <div>
      <PageHeader
        title="Support"
        description="Questions go straight to the merchant who sold you the item — they are the only ones who can check your stock, your delivery or your return."
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="space-y-4">
          <NewThreadForm orders={orderOptions} />

          <Card>
            <CardBody className="px-0 py-0">
              {threads.length === 0 ? (
                <div className="p-5">
                  <EmptyState title="No conversations yet" />
                </div>
              ) : (
                <ul>
                  {threads.map((t) => (
                    <li key={t.id} className="border-b border-border last:border-0">
                      <Link
                        href={`/support?thread=${t.id}`}
                        className={`block px-5 py-3 transition-colors hover:bg-muted ${
                          t.id === threadId ? "bg-muted" : ""
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{t.subject}</span>
                          <StatusBadge status={t.status} />
                        </div>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {t.counterparty}
                          {t.orderNumber ? ` · ${t.orderNumber}` : ""} · {t.messageCount} message
                          {t.messageCount === 1 ? "" : "s"}
                        </p>
                        <p className="mt-1 truncate text-xs text-subtle">{t.lastMessage}</p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>

        <Card className="h-fit">
          <CardBody>
            {open ? (
              <>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                  <div>
                    <p className="text-sm font-semibold">{open.thread.subject}</p>
                    <p className="text-xs text-muted-foreground">{open.thread.merchantName}</p>
                  </div>
                  <StatusBadge status={open.thread.status} />
                </div>
                <ThreadConversation
                  threadId={open.thread.id}
                  status={open.thread.status}
                  viewerRole="customer"
                  messages={open.messages.map((m) => ({
                    id: m.id,
                    senderRole: m.senderRole,
                    body: m.body,
                    createdAt: m.createdAt.toISOString(),
                  }))}
                />
              </>
            ) : (
              <EmptyState title="Select a conversation">
                Or start a new one on the left.
              </EmptyState>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
