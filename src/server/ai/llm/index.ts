import { createHash } from "node:crypto";
import { env } from "@/lib/env";
import { geminiProvider } from "./gemini";
import {
  cerebrasProvider,
  groqProvider,
  ollamaProvider,
  openrouterProvider,
} from "./openai-compatible";
import { LlmError, type CompleteOptions, type LlmProvider, type LlmResult } from "./types";

export * from "./types";

/**
 * Provider router with failover, rate-limit awareness and caching.
 *
 * Free tiers are rate-limited and occasionally down, so a single-provider
 * dependency would make the whole product flaky. The router tries the primary,
 * then every other configured provider, then the caller's deterministic
 * fallback — the platform degrades in answer quality, never in function.
 */

const PROVIDER_FACTORIES: Record<string, () => LlmProvider> = {
  groq: groqProvider,
  gemini: geminiProvider,
  openrouter: openrouterProvider,
  cerebras: cerebrasProvider,
  ollama: ollamaProvider,
};

/** Simple per-provider token bucket, so we skip a provider before it 429s. */
class RateLimiter {
  private hits = new Map<string, number[]>();

  allow(provider: string, rpm: number): boolean {
    const now = Date.now();
    const window = now - 60_000;
    const recent = (this.hits.get(provider) ?? []).filter((t) => t > window);
    if (recent.length >= rpm) {
      this.hits.set(provider, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(provider, recent);
    return true;
  }
}

const limiter = new RateLimiter();

/** Bounded in-memory cache. Identical prompts are common in a shopping session. */
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 200;
const cache = new Map<string, { at: number; result: LlmResult }>();

function cacheKey(options: CompleteOptions): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        t: options.task,
        s: options.system,
        m: options.messages,
        j: options.json,
        temp: options.temperature,
      }),
    )
    .digest("hex");
}

function readCache(key: string): LlmResult | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.result;
}

function writeCache(key: string, result: LlmResult) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), result });
}

/** Primary first, then every other configured provider. */
export function providerChain(): LlmProvider[] {
  const primary = env().LLM_PRIMARY;
  if (primary === "mock") return [];

  const ordered = [primary, ...Object.keys(PROVIDER_FACTORIES).filter((n) => n !== primary)];
  return ordered
    .map((name) => PROVIDER_FACTORIES[name]?.())
    .filter((p): p is LlmProvider => Boolean(p) && p.isConfigured());
}

export async function complete(options: CompleteOptions): Promise<LlmResult> {
  const key = cacheKey(options);
  const cached = readCache(key);
  if (cached) return cached;

  const attempts: Array<{ provider: string; error: string }> = [];

  for (const provider of providerChain()) {
    if (!limiter.allow(provider.name, provider.rpm)) {
      attempts.push({ provider: provider.name, error: "local rate limit reached" });
      continue;
    }
    try {
      const raw = await provider.complete(options);
      const result: LlmResult = { ...raw, degraded: false, attempts };
      writeCache(key, result);
      return result;
    } catch (cause) {
      const error = cause instanceof LlmError ? cause : new LlmError(String(cause), provider.name);
      attempts.push({ provider: provider.name, error: error.message });
      // Non-retryable errors (401/404) mean this provider is misconfigured;
      // keep going down the chain rather than failing the request.
    }
  }

  if (options.fallback) {
    return {
      text: options.fallback(),
      provider: "deterministic-fallback",
      model: "rule-based",
      latencyMs: 0,
      degraded: true,
      attempts,
    };
  }

  throw new LlmError(
    `no provider could serve this request (${attempts.map((a) => `${a.provider}: ${a.error}`).join("; ") || "none configured"})`,
    "router",
  );
}

/**
 * JSON completion with one repair attempt.
 *
 * Small free models frequently wrap JSON in prose or code fences, so we extract
 * the object before parsing and retry once with a blunt instruction.
 */
export async function completeJson<T>(
  options: CompleteOptions,
  validate: (value: unknown) => T,
): Promise<{ value: T; meta: LlmResult }> {
  const meta = await complete({ ...options, json: true });

  try {
    return { value: validate(parseLooseJson(meta.text)), meta };
  } catch (firstError) {
    if (meta.degraded) throw firstError;

    const repaired = await complete({
      ...options,
      json: true,
      temperature: 0,
      messages: [
        ...options.messages,
        { role: "assistant", content: meta.text.slice(0, 1500) },
        {
          role: "user",
          content:
            "That was not valid JSON matching the requested shape. Reply with the corrected JSON object only — no prose, no code fences.",
        },
      ],
    });
    try {
      return { value: validate(parseLooseJson(repaired.text)), meta: repaired };
    } catch (repairError) {
      // The repair failed too. Surface a described failure so the caller's
      // deterministic fallback can run, rather than a raw parser error.
      throw new LlmError(
        `model did not return usable JSON after one repair attempt: ${
          repairError instanceof Error ? repairError.message : String(repairError)
        }`,
        repaired.provider,
      );
    }
  }
}

/** Extracts a JSON object from a response that may include fences or prose. */
export function parseLooseJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to extraction
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // fall through
    }
  }

  const start = trimmed.search(/[{[]/);
  if (start >= 0) {
    const opener = trimmed[start];
    const closer = opener === "{" ? "}" : "]";
    const end = trimmed.lastIndexOf(closer);
    if (end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /*
         * A TRUNCATED response lands here: the model ran out of budget
         * mid-object, so there is an opening brace and some closing one, but
         * the slice between them is not valid JSON.
         *
         * This parse used to be unguarded, so it threw a bare
         * "SyntaxError: Unexpected end of JSON input" with no stack beyond
         * JSON.parse — which surfaced to the shopper as a 500 and an HTML
         * error page, and read in the UI as "could not reach the agent".
         * Callers all handle a failed parse; none of them could handle a
         * cryptic error they could not attribute.
         */
      }
    }
  }
  throw new LlmError(
    `response was not JSON (${trimmed.length} chars): ${trimmed.slice(0, 200)}`,
    "router",
  );
}

/** Which providers are usable right now — surfaced in the platform health view. */
export function providerStatus() {
  const primary = env().LLM_PRIMARY;
  const configured = providerChain().map((p) => p.name);
  return {
    primary,
    configured,
    usable: configured.length > 0,
    degradedMode: primary === "mock" || configured.length === 0,
  };
}
