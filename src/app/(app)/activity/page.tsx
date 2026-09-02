import { desc, eq, inArray } from "drizzle-orm";
import { PageHeader } from "@/components/page-header";
import { Badge, Card, CardBody, EmptyState, type Tone } from "@/components/ui";
import { db } from "@/db";
import { agentEvents, agentSessions } from "@/db/schema";
import { requireUser } from "@/lib/session";

/**
 * The audit trail.
 *
 * Renders the append-only event log as a timeline: what the agent observed,
 * what it decided and why, what it did, and how that turned out — including
 * the steps where it refused to act.
 */

const OUTCOME_TONE: Record<string, Tone> = {
  ok: "success",
  error: "danger",
  blocked: "warning",
  pending_approval: "info",
};

const VERDICT_TONE: Record<string, Tone> = {
  ALLOW: "success",
  REQUIRE_APPROVAL: "info",
  DENY: "danger",
};

export default async function ActivityPage() {
  const user = await requireUser();

  const sessions = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.userId, user.id))
    .orderBy(desc(agentSessions.createdAt))
    .limit(12);

  const events = sessions.length
    ? await db
        .select()
        .from(agentEvents)
        .where(inArray(agentEvents.sessionId, sessions.map((s) => s.id)))
        .orderBy(agentEvents.sequence)
    : [];

  const bySession = new Map<string, typeof events>();
  for (const event of events) {
    const list = bySession.get(event.sessionId) ?? [];
    list.push(event);
    bySession.set(event.sessionId, list);
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Agent activity"
        description="A complete, append-only record of what the agent observed, decided and executed. Refusals are recorded as visibly as completed actions."
      />

      {sessions.length === 0 ? (
        <EmptyState title="No agent activity yet" />
      ) : (
        <div className="space-y-4">
          {sessions.map((session) => {
            const timeline = bySession.get(session.id) ?? [];
            return (
              <Card key={session.id}>
                <CardBody className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {session.title ?? `${session.kind} session`}
                      </p>
                      <p className="mt-0.5 font-mono text-[11px] text-subtle">
                        {session.id.slice(0, 8)} ·{" "}
                        {session.createdAt.toLocaleString("en-IN", {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                    </div>
                    <Badge tone={session.state === "completed" ? "success" : "neutral"}>
                      {session.state}
                    </Badge>
                  </div>

                  {timeline.length === 0 ? (
                    <p className="text-xs text-subtle">No steps recorded.</p>
                  ) : (
                    <ol className="space-y-2.5 border-l border-border pl-4">
                      {timeline.map((event) => (
                        <li key={event.id} className="relative">
                          <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-primary" />
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-[11px] font-semibold">{event.step}</span>
                            <Badge tone={OUTCOME_TONE[event.outcome.status] ?? "neutral"}>
                              {event.outcome.status}
                            </Badge>
                            {event.action.verdict ? (
                              <Badge tone={VERDICT_TONE[event.action.verdict] ?? "neutral"}>
                                {event.action.verdict}
                              </Badge>
                            ) : null}
                            {event.outcome.provider && event.outcome.provider !== "deterministic-fallback" ? (
                              <span className="text-[11px] text-subtle">
                                {event.outcome.provider}/{event.outcome.model}
                              </span>
                            ) : event.outcome.provider ? (
                              <span className="text-[11px] text-subtle">deterministic</span>
                            ) : null}
                            {event.outcome.latencyMs !== undefined ? (
                              <span className="tabular text-[11px] text-subtle">
                                {event.outcome.latencyMs}ms
                              </span>
                            ) : null}
                          </div>

                          <p className="mt-0.5 text-sm">{event.observation.summary}</p>
                          <p className="text-xs text-muted-foreground">{event.reasoning.summary}</p>

                          {event.reasoning.criteria?.length ? (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-[11px] text-primary hover:underline">
                                scoring ({event.reasoning.criteria.length} criteria)
                              </summary>
                              <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-subtle">
                                {event.reasoning.criteria.map((criterion) => (
                                  <li key={criterion.name}>
                                    {criterion.name}: {criterion.weight} × {criterion.normalized} ={" "}
                                    {criterion.contribution}
                                  </li>
                                ))}
                              </ul>
                            </details>
                          ) : null}

                          {event.reasoning.rejectedAlternatives?.length ? (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-[11px] text-primary hover:underline">
                                ruled out ({event.reasoning.rejectedAlternatives.length})
                              </summary>
                              <ul className="mt-1 space-y-0.5 text-[11px] text-subtle">
                                {event.reasoning.rejectedAlternatives.slice(0, 6).map((alt) => (
                                  <li key={alt.ref + alt.label}>
                                    {alt.label} — {alt.reason}
                                  </li>
                                ))}
                              </ul>
                            </details>
                          ) : null}

                          {event.outcome.detail ? (
                            <p className="mt-0.5 text-[11px] text-subtle">{event.outcome.detail}</p>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  )}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
