/**
 * The single record shape every consequential agent step emits.
 *
 * Both the customer shopping agent and the merchant insights agent write these,
 * so one timeline UI and one query surface explain "what the agent observed,
 * decided and executed" for the whole platform.
 */

export type AgentStep =
  // customer agent
  | "UNDERSTAND"
  | "SEARCH"
  | "RANK"
  | "EXPLAIN"
  | "SELECT"
  | "CART"
  | "AUTHORIZE"
  | "PAY"
  | "CONFIRM"
  // merchant agent
  | "ANALYZE"
  | "RECOMMEND"
  | "EXECUTE"
  /*
   * Revenue-recovery agent.
   *
   * DETECT and DIAGNOSE are named separately from ANALYZE because they answer
   * different questions and can disagree: detection says money is at risk,
   * diagnosis says whether anything can be done about it, and a case that is
   * detected but undiagnosable is the one worth escalating. VERIFY is its own
   * step because recovery is only real when a payment is captured — folding it
   * into EXECUTE would let "message sent" read as "revenue recovered".
   */
  | "DETECT"
  | "DIAGNOSE"
  | "VERIFY"
  // cross-cutting
  | "POLICY_CHECK"
  | "MANDATE"
  | "ERROR";

export type Observation = {
  summary: string;
  /** What the agent was given or read, verbatim enough to audit. */
  inputs?: Record<string, unknown>;
  /** Which merchants / tables / endpoints were consulted. */
  sources?: string[];
  candidatesConsidered?: number;
};

/** One scored criterion. `contribution` = weight × normalized. */
export type Criterion = {
  name: string;
  weight: number;
  /** Raw measured value (price in minor units, days, count …). */
  value: number | string | boolean | null;
  /** 0..1 after normalisation. */
  normalized: number;
  contribution: number;
  note?: string;
};

export type RejectedAlternative = {
  ref: string;
  label: string;
  reason: string;
  score?: number;
};

export type Reasoning = {
  summary: string;
  criteria?: Criterion[];
  tradeoffs?: string;
  rejectedAlternatives?: RejectedAlternative[];
  /** Present only when an LLM produced narrative text for this step. */
  narrative?: string;
};

export type PolicyVerdict = "ALLOW" | "REQUIRE_APPROVAL" | "DENY";

export type Action = {
  type: string;
  params?: Record<string, unknown>;
  boundsChecked?: string[];
  verdict?: PolicyVerdict;
  requiresApproval?: boolean;
  approvalId?: string;
  mandateId?: string;
};

export type Outcome = {
  status: "ok" | "error" | "blocked" | "pending_approval";
  detail?: string;
  errorCode?: string;
  latencyMs?: number;
  model?: string;
  provider?: string;
  tokensIn?: number;
  tokensOut?: number;
};

export type AgentEventRecord = {
  step: AgentStep;
  observation: Observation;
  reasoning: Reasoning;
  action: Action;
  outcome: Outcome;
};
