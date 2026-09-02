import { env } from "@/lib/env";
import { LlmError, type CompleteOptions, type LlmProvider } from "./types";

/**
 * Shared client for OpenAI-compatible chat APIs.
 *
 * Groq, OpenRouter, Cerebras and Ollama all speak this dialect, so one
 * implementation covers four of the six providers.
 */
export function createOpenAiCompatibleProvider(config: {
  name: string;
  baseUrl: string;
  apiKey: () => string | undefined;
  model: () => string;
  rpm: number;
  requiresKey?: boolean;
  /** Extra gate beyond credentials. Used to keep local inference opt-in. */
  enabled?: () => boolean;
  extraHeaders?: () => Record<string, string>;
}): LlmProvider {
  return {
    name: config.name,
    rpm: config.rpm,
    isConfigured() {
      if (config.enabled && !config.enabled()) return false;
      return config.requiresKey === false ? Boolean(config.baseUrl) : Boolean(config.apiKey());
    },
    async complete(options: CompleteOptions) {
      const startedAt = Date.now();
      const messages = [
        ...(options.system ? [{ role: "system" as const, content: options.system }] : []),
        ...options.messages,
      ];

      const body: Record<string, unknown> = {
        model: config.model(),
        messages,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 900,
      };
      if (options.json) body.response_format = { type: "json_object" };
      // Only reasoning models accept this; others 400 on an unknown field.
      if (options.reasoningEffort && /gpt-oss|^o[134]|reasoning/i.test(config.model())) {
        body.reasoning_effort = options.reasoningEffort;
      }

      let response: Response;
      try {
        response = await fetch(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.apiKey() ? { Authorization: `Bearer ${config.apiKey()}` } : {}),
            ...(config.extraHeaders?.() ?? {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (cause) {
        throw new LlmError(
          `network error: ${(cause as Error).message}`,
          config.name,
          undefined,
          true,
        );
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new LlmError(
          `HTTP ${response.status}: ${detail.slice(0, 300)}`,
          config.name,
          response.status,
          // 429 and 5xx are worth trying elsewhere; 401/404 mean misconfiguration.
          response.status === 429 || response.status >= 500,
        );
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = payload.choices?.[0];
      const text = choice?.message?.content ?? "";
      if (!text) {
        // A reasoning model that spends its whole budget thinking returns an
        // empty string with finish_reason "length" — say so, so it is fixable.
        throw new LlmError(
          choice?.finish_reason === "length"
            ? `empty completion: token budget exhausted (finish_reason=length); raise maxTokens or lower reasoningEffort`
            : `empty completion (finish_reason=${choice?.finish_reason ?? "unknown"})`,
          config.name,
          undefined,
          true,
        );
      }

      return {
        text,
        provider: config.name,
        model: config.model(),
        tokensIn: payload.usage?.prompt_tokens,
        tokensOut: payload.usage?.completion_tokens,
        latencyMs: Date.now() - startedAt,
      };
    },
  };
}

export const groqProvider = () =>
  createOpenAiCompatibleProvider({
    name: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: () => env().GROQ_API_KEY,
    model: () => env().GROQ_MODEL,
    rpm: 30,
  });

export const openrouterProvider = () =>
  createOpenAiCompatibleProvider({
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: () => env().OPENROUTER_API_KEY,
    model: () => env().OPENROUTER_MODEL,
    rpm: 20,
    extraHeaders: () => ({
      "HTTP-Referer": env().PLATFORM_URL,
      "X-Title": "Agentic Commerce Platform",
    }),
  });

export const cerebrasProvider = () =>
  createOpenAiCompatibleProvider({
    name: "cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKey: () => env().CEREBRAS_API_KEY,
    model: () => env().CEREBRAS_MODEL,
    rpm: 30,
  });

/**
 * Local inference via Ollama.
 *
 * OPT-IN ONLY. This runs a multi-gigabyte LLM on the user's own machine, so it
 * is never a silent fallback: it activates solely when OLLAMA_BASE_URL is
 * explicitly set. Leaving that variable unset keeps every LLM call remote.
 */
export const ollamaProvider = () =>
  createOpenAiCompatibleProvider({
    name: "ollama",
    baseUrl: `${env().OLLAMA_BASE_URL ?? "http://localhost:11434"}/v1`,
    apiKey: () => undefined,
    model: () => env().OLLAMA_MODEL,
    rpm: 600,
    requiresKey: false,
    enabled: () => Boolean(env().OLLAMA_BASE_URL),
  });
