// Model client tests (task L3; docs/ARCHITECTURE.md, section 5). Uses a mock fetch
// function; no real network or real Gemini API call is ever made in tests.
import { describe, expect, it } from "vitest";
import {
  createFakeModelClient,
  createGeminiModelClient,
  estimateCostUsd,
} from "../../src/judge/model.ts";

describe("createGeminiModelClient", () => {
  it("sends the API key in x-goog-api-key header (never in URL), strict JSON schema and AbortSignal", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const fakeFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          responseId: "resp_abc123",
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: '{"verdict":"pass","evidence":[]}',
                  },
                ],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 1000,
            candidatesTokenCount: 40,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const client = createGeminiModelClient({
      apiKey: "fake-secret-key-do-not-leak",
      model: "gemini-2.5-flash",
      fetchFn: fakeFetch,
    });

    const ac = new AbortController();
    const reply = await client.complete("Evaluate constraint", ac.signal);

    expect(client.provider).toBe("google-gemini");
    expect(client.model).toBe("gemini-2.5-flash");
    expect(capturedUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(capturedUrl).not.toContain("fake-secret-key");

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("fake-secret-key-do-not-leak");
    expect(capturedInit?.signal).toBe(ac.signal);

    const body = JSON.parse(String(capturedInit?.body)) as {
      generationConfig: {
        temperature: number;
        responseMimeType: string;
        responseSchema: Record<string, unknown>;
      };
    };
    expect(body.generationConfig.temperature).toBe(0);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toBeDefined();

    expect(reply.text).toBe('{"verdict":"pass","evidence":[]}');
    expect(reply.requestId).toBe("resp_abc123");
    expect(reply.promptTokens).toBe(1000);
    expect(reply.completionTokens).toBe(40);
    expect(reply.costUsd).toBeCloseTo(
      estimateCostUsd("gemini-2.5-flash", 1000, 40),
      8,
    );
  });

  it("falls back to x-request-id header when responseId is absent and never leaks the API key on error", async () => {
    const secret = "AIzaFakeSecretKey999";
    const fakeFetch: typeof fetch = async () =>
      new Response(`error for key ${secret}`, {
        status: 429,
        statusText: "Too Many Requests",
      });

    const client = createGeminiModelClient({
      apiKey: secret,
      model: "gemini-2.5-flash",
      fetchFn: fakeFetch,
    });

    await expect(
      client.complete("prompt", new AbortController().signal),
    ).rejects.toSatisfy((err: Error) => !err.message.includes(secret));
  });

  it("reads x-request-id response header when responseId is missing from JSON", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '{"verdict":"unsure","evidence":[]}' }],
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "hdr-req-77",
          },
        },
      );

    const client = createGeminiModelClient({
      apiKey: "fake",
      model: "gemini-2.0-flash",
      fetchFn: fakeFetch,
    });

    const reply = await client.complete("prompt", new AbortController().signal);
    expect(reply.requestId).toBe("hdr-req-77");
    expect(reply.promptTokens).toBeNull();
    expect(reply.completionTokens).toBeNull();
    expect(reply.costUsd).toBe(0);
  });

  it("includes thoughtsTokenCount in completionTokens and costUsd and omits thought parts from text", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          responseId: "resp-think-1",
          candidates: [
            {
              content: {
                parts: [
                  { text: "internal reasoning...", thought: true },
                  { text: '{"verdict":"pass","evidence":[]}' },
                ],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 200,
            candidatesTokenCount: 10,
            thoughtsTokenCount: 140,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const client = createGeminiModelClient({
      apiKey: "fake",
      model: "gemini-2.5-flash",
      fetchFn: fakeFetch,
    });

    const reply = await client.complete("prompt", new AbortController().signal);
    expect(reply.text).toBe('{"verdict":"pass","evidence":[]}');
    expect(reply.completionTokens).toBe(150);
    expect(reply.costUsd).toBeCloseTo(
      estimateCostUsd("gemini-2.5-flash", 200, 150),
      8,
    );
  });
});

describe("createFakeModelClient", () => {
  it("exposes provider and model metadata and delegates complete()", async () => {
    const client = createFakeModelClient(
      async (prompt) => ({
        text: prompt,
        requestId: "fake-id",
        promptTokens: 1,
        completionTokens: 1,
        costUsd: 0,
      }),
      { provider: "test-provider", model: "test-model" },
    );
    expect(client.provider).toBe("test-provider");
    expect(client.model).toBe("test-model");
    const r = await client.complete("hi", new AbortController().signal);
    expect(r.text).toBe("hi");
  });
});
