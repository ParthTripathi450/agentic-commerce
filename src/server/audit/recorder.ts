import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentEvents, agentSessions } from "@/db/schema";
import type { AgentEventRecord, AgentStep } from "@/lib/agent-types";

/**
 * The audit trail.
 *
 * Append-only: events are never updated or deleted, so the record of what an
 * agent observed, decided and executed cannot be quietly revised after the
 * fact. Every consequential step in both agents writes through here.
 */

export type StartSessionInput = {
  userId: string;
  kind: "customer" | "merchant";
  merchantId?: string | null;
  title?: string;
};

export async function startSession(input: StartSessionInput) {
  const [session] = await db
    .insert(agentSessions)
    .values({
      userId: input.userId,
      kind: input.kind,
      merchantId: input.merchantId ?? null,
      title: input.title ?? null,
      state: "active",
    })
    .returning();
  return session;
}

export async function getSession(sessionId: string) {
  const [session] = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return session ?? null;
}

/**
 * Appends one event. The sequence number is assigned from the database so
 * concurrent writers cannot collide or reorder the trail.
 */
export async function record(sessionId: string, event: AgentEventRecord) {
  const [inserted] = await db
    .insert(agentEvents)
    .values({
      sessionId,
      sequence: sql`(SELECT COALESCE(MAX(sequence), 0) + 1 FROM agent_events WHERE session_id = ${sessionId})`,
      step: event.step,
      observation: event.observation,
      reasoning: event.reasoning,
      action: event.action,
      outcome: event.outcome,
    })
    .returning();
  return inserted;
}

/** Records a step and keeps the session's current position in step. */
export async function recordAndAdvance(
  sessionId: string,
  event: AgentEventRecord,
  context?: Record<string, unknown>,
) {
  const inserted = await record(sessionId, event);
  await db
    .update(agentSessions)
    .set({
      currentStep: event.step,
      updatedAt: new Date(),
      ...(context ? { context: sql`${agentSessions.context} || ${JSON.stringify(context)}::jsonb` } : {}),
    })
    .where(eq(agentSessions.id, sessionId));
  return inserted;
}

export async function setSessionState(
  sessionId: string,
  state: "active" | "awaiting_approval" | "completed" | "failed" | "abandoned",
) {
  await db
    .update(agentSessions)
    .set({ state, updatedAt: new Date() })
    .where(eq(agentSessions.id, sessionId));
}

export async function getTimeline(sessionId: string) {
  return db
    .select()
    .from(agentEvents)
    .where(eq(agentEvents.sessionId, sessionId))
    .orderBy(agentEvents.sequence);
}

export async function listSessions(userId: string, limit = 20) {
  return db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.userId, userId))
    .orderBy(desc(agentSessions.updatedAt))
    .limit(limit);
}

/** Wraps a step so failures are audited rather than swallowed. */
export async function recordStep<T>(
  sessionId: string,
  step: AgentStep,
  fn: () => Promise<{ result: T; event: Omit<AgentEventRecord, "step"> }>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const { result, event } = await fn();
    await recordAndAdvance(sessionId, {
      step,
      ...event,
      outcome: { latencyMs: Date.now() - startedAt, ...event.outcome },
    });
    return result;
  } catch (cause) {
    const error = cause as Error;
    await recordAndAdvance(sessionId, {
      step,
      observation: { summary: `Step ${step} failed before completing.` },
      reasoning: { summary: "Execution raised an error." },
      action: { type: step.toLowerCase() },
      outcome: {
        status: "error",
        detail: error.message,
        errorCode: error.name,
        latencyMs: Date.now() - startedAt,
      },
    });
    throw error;
  }
}
