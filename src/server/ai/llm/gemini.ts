import { env } from "@/lib/env";
import { LlmError, type CompleteOptions, type LlmProvider } from "./types";

/** Google AI Studio (Gemini). Free tier, no card, but a distinct REST dialect. */
export function geminiProvider(): LlmProvider {
  return {
    name: "gemini",
    rpm: 10,
    isConfigured: () => Boolean(env().GEMINI_API_KEY),
    async complete(options: CompleteOptions) {
      const startedAt = Date.now();
      const model = env().GEMINI_MODEL;

      // Gemini has no "system" role: it takes systemInstruction separately and
      // maps assistant turns to "model".
      const contents = options.messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

      const body: Record<string, unknown> = {
        contents,
        generationConfig: {
          temperature: options.temperature ?? 0.2,
          maxOutputTokens: options.maxTokens ?? 900,
          ...(options.json ? { responseMimeType: "application/json" } : {}),
        },
      };
      if (options.system) {
        body.systemInstruction = { parts: [{ text: options.system }] };
      }

      let response: Response;
      try {
        response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": env().GEMINI_API_KEY!,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
          },
        );
      } catch (cause) {
        throw new LlmError(`network error: ${(cause as Error).message}`, "gemini", undefined, true);
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new LlmError(
          `HTTP ${response.status}: ${detail.slice(0, 300)}`,
          "gemini",
          response.status,
          response.status === 429 || response.status >= 500,
        );
      }

      const payload = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const text =
        payload.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (!text) throw new LlmError("empty completion", "gemini", undefined, true);

      return {
        text,
        provider: "gemini",
        model,
        tokensIn: payload.usageMetadata?.promptTokenCount,
        tokensOut: payload.usageMetadata?.candidatesTokenCount,
        latencyMs: Date.now() - startedAt,
      };
    },
  };
}
