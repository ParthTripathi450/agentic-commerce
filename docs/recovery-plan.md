# AI Revenue Recovery Agent — plan

## What already exists (extend, never rebuild)

| Need | Existing thing | Verdict |
|---|---|---|
| detect → recommend → approve → execute loop | `insights` + merchant agent + `approvals` | extend the SHAPE, new domain |
| deterministic financial gate | `evaluatePolicy()` → ALLOW / REQUIRE_APPROVAL / DENY | extend with recovery limits |
| audit trail | `agent_events` (append-only) + `record()` / `startSession()` | reuse verbatim |
| failed payments | `payments.state='failed'`, `failureReason`, `raw` | reuse |
| abandonment | `carts.status`, `checkout_sessions` states, `releaseExpiredCheckouts` | reuse |
| customer outreach | `support_threads` + `support_messages` | reuse — a REAL channel |
| bounded incentive | `promotions` (code, value, category scope, `activeTo`) | reuse |
| recovery payment | existing checkout + `/api/commerce/*` | reuse |

**Confirmed absent: subscriptions and invoices.** Scenarios D and E get a
`scenario` enum slot and a documented extension point — no fake tables, no
pretend dunning.

## The gap this fills

The merchant agent detects INVENTORY risk. Nothing detects REVENUE risk. The
loop is the same; the domain is new.

## Build order

1. **Schema** — `recovery_cases`. One row per case: scenario, subject refs,
   amount at risk, state, diagnosis, attempt counters, recovered amount, stop
   reason, `sessionId` linking to the audit trail. A partial unique index stops
   the same order being worked twice.
2. **DETECT** (`detect.ts`) — deterministic SQL, no LLM.
   A failed payment · B abandoned checkout · C payment degradation.
3. **DIAGNOSE** (`diagnose.ts`) — pure. Maps failure text + counts + timing to
   `temporary | customer_action_required | repeated | unknown`. Never asserts a
   cause the gateway did not give; unknown escalates.
4. **DETERMINE** (`determine.ts`) — pure decision table over diagnosis, value,
   attempts, elapsed time. Emits a proposed `Action`.
5. **POLICY** — extend `PolicyAction`/`PolicyLimits`: max retries (2), max
   messages (2), max discount bp (1000) and cash cap (₹500), auto-recovery
   switch. The LLM never reaches this; it is a table lookup.
6. **ACT** (`act.ts`) — through existing services only: support thread for
   outreach, a bounded scoped promotion for an incentive, a recovery link to the
   real checkout. **No silent re-charging** — there is no stored credential, so
   claiming a retry would be a lie.
7. **VERIFY** (`verify.ts`) — recovered only when a payment reaches `captured`.
   Money attributed once, on a genuine transition.
8. **RECORD** — every step through `record()` with the existing step vocabulary.
9. **Runner + merchant UI** — `/merchant/recovery`: at-risk vs recovered,
   per-case timeline, approve/reject, stop reasons.
10. **Tests** — the pure stages hardest: stopping rules, no-invented-cause,
    bounded discounts, idempotent detection.

## Rules that must hold

- The LLM never authorises money. It may only phrase an outreach message, and
  only from facts the case already contains.
- Every action is bounded and counted; every stop states its reason.
- Recovery is idempotent — re-running the sweep must not double-message,
  double-discount or double-count revenue.
