import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  Action,
  AgentStep,
  Observation,
  Outcome,
  PolicyVerdict,
  Reasoning,
} from "@/lib/agent-types";
import { createdAt, pk, updatedAt } from "./_shared";
import { users } from "./auth";
import { merchants } from "./merchant";

export const agentKind = pgEnum("agent_kind", ["customer", "merchant"]);
export const agentSessionState = pgEnum("agent_session_state", [
  "active",
  "awaiting_approval",
  "completed",
  "failed",
  "abandoned",
]);

export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: pk(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    merchantId: varchar("merchant_id", { length: 36 }).references(() => merchants.id, {
      onDelete: "cascade",
    }),
    kind: agentKind("kind").notNull(),
    state: agentSessionState("state").notNull().default("active"),
    title: varchar("title", { length: 240 }),
    /** Current node of the agent state machine. */
    currentStep: varchar("current_step", { length: 32 }),
    /** Working memory: parsed intent, candidate set, selection, cart id. */
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("agent_sessions_user_idx").on(t.userId)],
);

/** The audit trail. Append-only: rows are never updated or deleted. */
export const agentEvents = pgTable(
  "agent_events",
  {
    id: pk(),
    sessionId: varchar("session_id", { length: 36 })
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    step: varchar("step", { length: 32 }).$type<AgentStep>().notNull(),
    observation: jsonb("observation").$type<Observation>().notNull(),
    reasoning: jsonb("reasoning").$type<Reasoning>().notNull(),
    action: jsonb("action").$type<Action>().notNull(),
    outcome: jsonb("outcome").$type<Outcome>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("agent_events_session_seq_idx").on(t.sessionId, t.sequence)],
);

export const mandateType = pgEnum("mandate_type", ["intent", "cart", "payment"]);
export const mandateStatus = pgEnum("mandate_status", [
  "active",
  "consumed",
  "expired",
  "revoked",
  "invalid",
]);

/**
 * AP2 mandate chain: intent → cart → payment.
 *
 * Each row stores the canonical payload plus its detached JWS. `parentId` makes
 * the chain walkable, and `payloadHash` is what the child signs over — so a cart
 * whose price is edited after signing no longer matches its Payment Mandate and
 * the charge is refused.
 */
export const mandates = pgTable(
  "mandates",
  {
    id: pk(),
    type: mandateType("type").notNull(),
    parentId: varchar("parent_id", { length: 36 }),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    merchantId: varchar("merchant_id", { length: 36 }).references(() => merchants.id, {
      onDelete: "cascade",
    }),
    sessionId: varchar("session_id", { length: 36 }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    /** Detached JWS, ES256. Multiple signers appear as separate entries. */
    signatures: jsonb("signatures")
      .$type<Array<{ signer: string; kid: string; jws: string }>>()
      .notNull()
      .default([]),
    status: mandateStatus("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("mandates_user_idx").on(t.userId),
    index("mandates_parent_idx").on(t.parentId),
  ],
);

export const policyScope = pgEnum("policy_scope", ["user", "merchant", "platform"]);

/**
 * Configurable bounds evaluated before every money-moving or catalog-mutating
 * action. Absent limits fall back to platform defaults in the policy engine.
 */
export type PolicyLimits = {
  // customer-side
  maxOrderValueMinor?: number;
  maxDailySpendMinor?: number;
  maxItemsPerOrder?: number;
  requireApprovalAboveMinor?: number;
  allowedMerchantIds?: string[];
  blockedMerchantIds?: string[];
  allowedCategories?: string[];
  // merchant-agent-side
  maxPriceChangeBp?: number;
  maxDiscountBp?: number;
  maxRestockUnits?: number;
  maxRestockCostMinor?: number;
  allowAutoPublish?: boolean;
  requireApprovalForAll?: boolean;
  // revenue-recovery side
  /** Recovery links offered for one case before it stops. */
  maxRecoveryRetries?: number;
  /** Messages sent to one shopper about one case before it stops. */
  maxRecoveryMessages?: number;
  /** Largest discount the agent may offer unaided, in basis points. */
  maxRecoveryDiscountBp?: number;
  /** And its cash ceiling, so a percentage cannot become a large sum. */
  maxRecoveryDiscountMinor?: number;
  /**
   * Whether recovery may act without a human at all.
   *
   * Off means every action becomes an approval — which is a legitimate way for
   * a cautious merchant to run this, not a degraded mode.
   */
  allowAutoRecovery?: boolean;
};

export const agentPolicies = pgTable("agent_policies", {
  id: pk(),
  scope: policyScope("scope").notNull(),
  scopeId: varchar("scope_id", { length: 36 }),
  limits: jsonb("limits").$type<PolicyLimits>().notNull().default({}),
  updatedAt: updatedAt(),
  createdAt: createdAt(),
});

export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
]);

/** Human-in-the-loop gate. Nothing consequential proceeds without a decision. */
export const approvals = pgTable(
  "approvals",
  {
    id: pk(),
    sessionId: varchar("session_id", { length: 36 }).references(() => agentSessions.id, {
      onDelete: "cascade",
    }),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    merchantId: varchar("merchant_id", { length: 36 }).references(() => merchants.id, {
      onDelete: "cascade",
    }),
    action: jsonb("action").$type<Action>().notNull(),
    /** Human-readable statement of exactly what is being authorised. */
    summary: text("summary").notNull(),
    verdict: varchar("verdict", { length: 20 }).$type<PolicyVerdict>().notNull(),
    reason: text("reason").notNull(),
    status: approvalStatus("status").notNull().default("pending"),
    decidedBy: varchar("decided_by", { length: 36 }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("approvals_status_idx").on(t.status)],
);

export const insightKind = pgEnum("insight_kind", [
  "restock",
  "stockout_risk",
  "overstock",
  "price_adjustment",
  "promotion",
  "availability",
  "demand_trend",
  "catalog_quality",
]);
export const insightSeverity = pgEnum("insight_severity", ["info", "warning", "critical"]);
export const insightStatus = pgEnum("insight_status", [
  "open",
  "approved",
  "executed",
  "dismissed",
  "expired",
]);

/**
 * A merchant-agent recommendation. `evidence` carries the numbers behind it so
 * the agent can justify itself on demand without re-inventing a rationale.
 */
export const insights = pgTable(
  "insights",
  {
    id: pk(),
    merchantId: varchar("merchant_id", { length: 36 })
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    sessionId: varchar("session_id", { length: 36 }),
    kind: insightKind("kind").notNull(),
    severity: insightSeverity("severity").notNull().default("info"),
    title: varchar("title", { length: 240 }).notNull(),
    /** Plain-language explanation, grounded in `evidence`. */
    explanation: text("explanation").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    /** The concrete action proposed, ready to hand to the policy engine. */
    recommendation: jsonb("recommendation").$type<Action>().notNull(),
    projectedImpact: jsonb("projected_impact").$type<{
      metric: string;
      valueMinor?: number;
      value?: number;
      confidence: "low" | "medium" | "high";
      basis: string;
    }>(),
    status: insightStatus("status").notNull().default("open"),
    approvalId: varchar("approval_id", { length: 36 }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    dismissedReason: text("dismissed_reason"),
    autoExecutable: boolean("auto_executable").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("insights_merchant_status_idx").on(t.merchantId, t.status)],
);

export const agentSessionsRelations = relations(agentSessions, ({ many, one }) => ({
  events: many(agentEvents),
  user: one(users, { fields: [agentSessions.userId], references: [users.id] }),
}));

export const agentEventsRelations = relations(agentEvents, ({ one }) => ({
  session: one(agentSessions, {
    fields: [agentEvents.sessionId],
    references: [agentSessions.id],
  }),
}));
