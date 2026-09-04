import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { createdAt, currency, pk, updatedAt } from "./_shared";
import { users } from "./auth";
import { merchants } from "./merchant";
import { carts, orders, payments } from "./commerce";

/**
 * Which kind of revenue loss this case is about.
 *
 * `failed_subscription` and `overdue_invoice` are named but NOT detected: this
 * marketplace has no subscriptions and no invoices, and inventing the tables to
 * demonstrate a dunning flow would be a fake feature dressed as a real one. The
 * slots exist so those scenarios can be added later without a migration or a
 * change to any of the stages below.
 */
export const recoveryScenario = pgEnum("recovery_scenario", [
  "failed_payment",
  "abandoned_checkout",
  "payment_degradation",
  "failed_subscription",
  "overdue_invoice",
]);

/**
 * What the evidence supports, and nothing more.
 *
 * `unknown` is a first-class outcome rather than a fallback nobody reaches: a
 * gateway that says only "payment failed" does not tell you whether the card
 * was declined or the customer closed the tab, and guessing between them picks
 * the intervention for a problem the shopper may not have.
 */
export const recoveryDiagnosis = pgEnum("recovery_diagnosis", [
  "likely_temporary",
  "customer_action_required",
  "repeated_failure",
  "abandoned_before_payment",
  "abandoned_at_payment",
  "unknown",
]);

export const recoveryState = pgEnum("recovery_state", [
  "detected",
  "diagnosed",
  "awaiting_approval",
  "acting",
  "verifying",
  "recovered",
  "stopped",
  "escalated",
  "expired",
]);

/**
 * One case per piece of revenue at risk.
 *
 * The case IS the unit of work and the unit of audit: it carries what was
 * detected, what the evidence supported, what was decided, what was done, what
 * came back, and how much money actually returned. `sessionId` links it to the
 * append-only `agent_events` trail, so the summary here and the step-by-step
 * record there cannot drift apart.
 *
 * Counters live on the row rather than being derived from the event log,
 * because the stopping rules are enforced BEFORE acting and a rule that has to
 * replay history to answer "how many messages have we sent" is a rule that
 * eventually miscounts.
 */
export const recoveryCases = pgTable(
  "recovery_cases",
  {
    id: pk(),
    merchantId: varchar("merchant_id", { length: 36 })
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),
    /** The shopper whose revenue is at risk. */
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    scenario: recoveryScenario("scenario").notNull(),
    state: recoveryState("state").notNull().default("detected"),

    // ---- what this case is about; exactly one subject is set ----
    orderId: varchar("order_id", { length: 36 }).references(() => orders.id, { onDelete: "cascade" }),
    cartId: varchar("cart_id", { length: 36 }).references(() => carts.id, { onDelete: "cascade" }),
    paymentId: varchar("payment_id", { length: 36 }).references(() => payments.id, { onDelete: "set null" }),

    /** What is on the table, in minor units. The number every metric sums. */
    amountAtRiskMinor: integer("amount_at_risk_minor").notNull(),
    currency: currency(),

    diagnosis: recoveryDiagnosis("diagnosis"),
    /**
     * What the diagnosis was actually based on — the raw signals, not prose.
     * Kept so a case can be argued with rather than merely read.
     */
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),

    // ---- bounded action counters, checked BEFORE acting ----
    retryCount: integer("retry_count").notNull().default(0),
    messageCount: integer("message_count").notNull().default(0),
    /** Total value of incentives granted, so the cash cap is enforceable. */
    incentiveMinor: integer("incentive_minor").notNull().default(0),

    /** Earliest the agent may touch this case again. Enforces the wait. */
    nextActionAt: timestamp("next_action_at", { withTimezone: true }),

    /** Money that actually came back, attributed once on a real transition. */
    recoveredMinor: integer("recovered_minor").notNull().default(0),
    recoveredAt: timestamp("recovered_at", { withTimezone: true }),

    /** Why the agent stopped. Never null once `state` is stopped or escalated. */
    stopReason: text("stop_reason"),

    /** The approval this case is waiting on, when one was required. */
    approvalId: varchar("approval_id", { length: 36 }),

    /** Links every step of this case to the append-only audit trail. */
    sessionId: varchar("session_id", { length: 36 }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("recovery_merchant_idx").on(t.merchantId, t.state),
    index("recovery_next_action_idx").on(t.nextActionAt),
    /*
     * One open case per subject.
     *
     * The sweep is meant to be run repeatedly — on a schedule, or by a merchant
     * clicking a button — and without this a second pass opens a second case
     * for the same failed payment, messages the shopper twice and counts the
     * revenue twice. Idempotent detection is the property that makes the
     * numbers on the dashboard mean anything.
     */
    /*
     * One case per subject, EVER — not merely one open case.
     *
     * Scoping this to open states was wrong and the sweep proved it: once a
     * case escalated it stopped colliding, so the next sweep re-detected the
     * same failed payment and opened another. Three passes produced thirteen
     * cases for five risks and twelve escalation threads to the merchant.
     *
     * An escalated or stopped case has an owner and an outcome. Re-detecting it
     * is not vigilance, it is spam with a fresh row id.
     */
    uniqueIndex("recovery_one_case_per_order_idx").on(t.orderId),
    uniqueIndex("recovery_one_case_per_cart_idx").on(t.cartId),
  ],
);
