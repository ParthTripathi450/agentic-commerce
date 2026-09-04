import { z } from "zod";

/**
 * Environment access.
 *
 * Deliberately lazy + partial: the platform must boot with *no* third-party keys
 * configured. Missing AI or payment credentials degrade to the built-in `mock`
 * providers rather than crashing the app, so the whole flow stays demoable
 * before any signup. Only DATABASE_URL and AUTH_SECRET are truly required.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be at least 16 chars"),

  PLATFORM_URL: z.string().url().default("http://localhost:3000"),

  // --- AI providers (all optional; all have no-card free tiers) ---
  LLM_PRIMARY: z
    .enum(["groq", "gemini", "openrouter", "cerebras", "ollama", "mock"])
    .default("groq"),
  GROQ_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  CEREBRAS_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().optional(),

  // Model ids are overridable: provider catalogues change faster than code.
  GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),
  /*
   * Lighter model for high-frequency conversational turns.
   *
   * Groq's free tier caps tokens PER DAY PER MODEL, so routing the chattiest
   * task to a second model both burns fewer tokens and draws from a separate
   * daily pool — one exhausted model no longer takes the whole agent down.
   */
  GROQ_FAST_MODEL: z.string().default("openai/gpt-oss-20b"),
  /**
   * `gemini-flash-latest`, not a pinned version.
   *
   * Verified against this account: `gemini-2.5-flash` returns 429 on the free
   * quota and `gemini-2.0-flash` is retired outright ("no longer available"),
   * while the floating alias answers normally. Every provider here rotates its
   * catalogue (§8.6), and for a FAILOVER path a name that keeps working
   * unattended beats a pin that quietly becomes a 404 on the day it is needed.
   */
  GEMINI_MODEL: z.string().default("gemini-flash-latest"),
  /**
   * The previous default stopped being free: OpenRouter answers
   * `meta-llama/llama-3.3-70b-instruct:free` with a 404 pointing at the paid
   * slug. `z-ai/glm-5.2:free` was picked by listing the account's free models
   * and testing each on a JSON request — it returned clean, parseable JSON,
   * where `nvidia/nemotron-3-ultra-550b-a55b:free` answered 200 with malformed
   * output, which is worse than failing.
   */
  OPENROUTER_MODEL: z.string().default("z-ai/glm-5.2:free"),
  /**
   * `llama-3.3-70b` does not exist on Cerebras any more; the account offers
   * `gpt-oss-120b`, `qwen-3.8-27b` and `gemma-4-31b`. The name is corrected
   * here, but note every one of them returns **402 Payment required** on this
   * account — Cerebras cannot serve the no-card constraint (§1) today, so it
   * is configured, harmless, and simply failed past.
   */
  CEREBRAS_MODEL: z.string().default("gpt-oss-120b"),
  OLLAMA_MODEL: z.string().default("llama3.1"),

  // --- Payments ---
  PAYMENT_GATEWAY: z.enum(["razorpay", "mock"]).default("mock"),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // --- Storage (local disk by default; Supabase Storage free tier on deploy) ---
  STORAGE_DRIVER: z.enum(["local", "supabase"]).optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default("product-images"),

  // --- Embeddings (local by default: no key, no rate limit) ---
  EMBEDDING_PROVIDER: z.enum(["local", "gemini"]).default("local"),
  EMBEDDING_MODEL: z.string().default("Xenova/all-MiniLM-L6-v2"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Dimensionality of the local MiniLM embedding model. */
export const EMBEDDING_DIMENSIONS = 384;
