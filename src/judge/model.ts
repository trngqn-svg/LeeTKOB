// Model clients for semantic constraint checking (task L3; docs/ARCHITECTURE.md,
// section 5). Supports the Google Gemini REST API and a fake client for tests.
import type { ModelClient, ModelReply } from "./types.ts";

const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";

/**
 * Estimates list-price USD cost from token counts for Gemini models.
 * Note: our free-tier key has a US$0 spending cap (decisions 6); this number is
 * list-price arithmetic for cost reporting and call logs.
 */
export function estimateCostUsd(
  model: string,
  promptTokens: number | null,
  completionTokens: number | null,
): number {
  if (promptTokens === null && completionTokens === null) return 0;
  const inTok = promptTokens ?? 0;
  const outTok = completionTokens ?? 0;

  let inputPerMillion = 0.3;
  let outputPerMillion = 2.5;
  if (model.includes("pro")) {
    inputPerMillion = 1.25;
    outputPerMillion = 10.0;
  } else if (model.includes("flash-lite") || model.includes("2.0-flash")) {
    inputPerMillion = 0.1;
    outputPerMillion = 0.4;
  }

  return (
    (inTok / 1_000_000) * inputPerMillion +
    (outTok / 1_000_000) * outputPerMillion
  );
}

interface GeminiResponsePayload {
  responseId?: string;
  candidates?: {
    content?: {
      parts?: { text?: string }[];
    };
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

/**
 * Creates a Google Gemini REST client using `x-goog-api-key` and structured JSON
 * output matching the verdict/evidence schema.
 */
export function createGeminiModelClient(options: {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}): ModelClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const fetchImpl = options.fetchFn ?? fetch;

  return {
    provider: "google-gemini",
    model: options.model,
    async complete(prompt: string, signal: AbortSignal): Promise<ModelReply> {
      const url = `${baseUrl}/v1beta/models/${encodeURIComponent(options.model)}:generateContent`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": options.apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                verdict: {
                  type: "STRING",
                  enum: ["pass", "violation", "unsure"],
                },
                evidence: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: {
                      line: { type: "INTEGER" },
                      text: { type: "STRING" },
                    },
                    required: ["line", "text"],
                  },
                },
              },
              required: ["verdict", "evidence"],
            },
          },
        }),
        signal,
      });

      if (!response.ok) {
        // Never leak the API key in error messages.
        throw new Error(
          `Gemini API error ${response.status} (${response.statusText})`,
        );
      }

      const data = (await response.json()) as GeminiResponsePayload;
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      const text = parts.map((p) => p.text ?? "").join("");
      const requestId =
        data.responseId ??
        response.headers.get("x-request-id") ??
        response.headers.get("x-goog-request-id") ??
        null;
      const promptTokens = data.usageMetadata?.promptTokenCount ?? null;
      const completionTokens = data.usageMetadata?.candidatesTokenCount ?? null;

      return {
        text,
        requestId,
        promptTokens,
        completionTokens,
        costUsd: estimateCostUsd(options.model, promptTokens, completionTokens),
      };
    },
  };
}

/** Creates an in-memory fake model client for tests. */
export function createFakeModelClient(
  completeFn: (prompt: string, signal: AbortSignal) => Promise<ModelReply>,
  meta?: { provider?: string; model?: string },
): ModelClient {
  return {
    provider: meta?.provider ?? "fake",
    model: meta?.model ?? "fake-model",
    complete: completeFn,
  };
}
