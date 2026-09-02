export type ChatRole = "system" | "user" | "assistant";
export type ChatMessage = { role: ChatRole; content: string };

/**
 * The task a completion serves. The mock provider uses this to produce a
 * genuinely useful deterministic answer rather than a placeholder, which is
 * what lets the platform run end-to-end with no API key at all.
 */
export type LlmTask =
  | "parse_intent"
  | "explain_selection"
  | "merchant_insight"
  | "generic";

export type CompleteOptions = {
  task: LlmTask;
  system?: string;
  messages: ChatMessage[];
  /** Ask for JSON. The router validates and repairs before returning. */
  json?: boolean;
  /**
   * Reasoning models spend part of the token budget thinking. Keeping this
   * low leaves room for the actual answer on short, well-specified tasks.
   */
  reasoningEffort?: "low" | "medium" | "high";
  maxTokens?: number;
  temperature?: number;
  /**
   * Deterministic answer used when no provider is reachable (or LLM_PRIMARY is
   * "mock"). Supplied by the calling domain module, which knows how to answer
   * without a model — so the platform degrades in quality, never in function.
   */
  fallback?: () => string;
};

export type LlmResult = {
  text: string;
  provider: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs: number;
  /** True when served by the deterministic fallback rather than a real model. */
  degraded: boolean;
  /** Providers that failed before this one succeeded, with the reason. */
  attempts: Array<{ provider: string; error: string }>;
};

export interface LlmProvider {
  readonly name: string;
  isConfigured(): boolean;
  /** Requests per minute permitted on the provider's free tier. */
  readonly rpm: number;
  complete(options: CompleteOptions): Promise<Omit<LlmResult, "degraded" | "attempts">>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "LlmError";
  }
}
