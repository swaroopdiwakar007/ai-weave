/**
 * Shared contract suite: every provider adapter must normalize responses and errors the same way.
 * Each adapter test supplies recorded-style fixtures in its vendor's wire format.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AuthError,
  ContextLengthError,
  ProviderError,
  RateLimitError,
  createWeave,
  type FetchLike,
  type GenerateRequest,
  type Provider,
} from "@ai-weave/core";

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal | null;
}

/** A fake fetch that replays scripted responses and records requests. */
export function scriptedFetch(replies: Array<Response | Error | (() => Response)>) {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    requests.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : {},
      signal: init?.signal,
    });
    const reply = replies.shift();
    if (!reply) throw new Error("scriptedFetch: no more replies");
    if (reply instanceof Error) throw reply;
    return typeof reply === "function" ? reply() : reply;
  };
  return { fetch, requests };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export interface ContractFixtures {
  name: string;
  /** Env var(s) holding the API key; cleared for the missing-key test. */
  envVars: string[];
  create(fetch: FetchLike, options?: { apiKey?: string }): Provider;
  /** Successful text response. */
  text(text: string, usage: { input: number; output: number }): unknown;
  /** Response containing one tool call. */
  toolCall(id: string, name: string, input: Record<string, unknown>): unknown;
  /** Response to a request with `responseFormat` (named `schemaName`). */
  structured(value: Record<string, unknown>, schemaName: string): unknown;
  /** Vendor error body. */
  errorBody(message: string): unknown;
}

const baseRequest: GenerateRequest = {
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" },
  ],
};

export function runProviderContract(f: ContractFixtures): void {
  describe(`${f.name} provider contract`, () => {
    it("returns normalized text, usage and finish reason", async () => {
      const { fetch } = scriptedFetch([json(f.text("Hi there", { input: 12, output: 3 }))]);
      const res = await f.create(fetch, { apiKey: "k" }).generate(baseRequest);
      expect(res.text).toBe("Hi there");
      expect(res.toolCalls).toEqual([]);
      expect(res.finishReason).toBe("stop");
      expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
      expect(res.raw).toBeDefined();
    });

    it("returns normalized tool calls", async () => {
      const { fetch } = scriptedFetch([
        json(f.toolCall("call_1", "saveRecipe", { title: "Soup" })),
      ]);
      const res = await f.create(fetch, { apiKey: "k" }).generate({
        ...baseRequest,
        tools: [{ name: "saveRecipe", inputSchema: { type: "object" } }],
      });
      expect(res.finishReason).toBe("tool_calls");
      expect(res.toolCalls).toHaveLength(1);
      expect(res.toolCalls[0]).toMatchObject({ name: "saveRecipe", input: { title: "Soup" } });
      expect(res.toolCalls[0]!.id).toBeTruthy();
    });

    it("returns JSON text for structured output", async () => {
      const { fetch } = scriptedFetch([json(f.structured({ title: "Soup" }, "result"))]);
      const res = await f.create(fetch, { apiKey: "k" }).generate({
        ...baseRequest,
        responseFormat: { type: "json", name: "result", schema: { type: "object" } },
      });
      expect(JSON.parse(res.text)).toEqual({ title: "Soup" });
      expect(res.finishReason).toBe("stop");
      expect(res.toolCalls).toEqual([]);
    });

    it("maps HTTP errors to the error taxonomy", async () => {
      const cases: Array<[Response, new (...a: never[]) => Error, boolean]> = [
        [json(f.errorBody("invalid x-api-key"), 401), AuthError, false],
        [json(f.errorBody("rate limited"), 429, { "retry-after": "3" }), RateLimitError, true],
        [json(f.errorBody("internal error"), 500), ProviderError, true],
        [
          json(f.errorBody("prompt is too long: maximum context length exceeded"), 400),
          ContextLengthError,
          false,
        ],
        [new Response("<html>bad gateway</html>", { status: 502 }), ProviderError, true],
      ];
      for (const [response, type, retryable] of cases) {
        const { fetch } = scriptedFetch([response]);
        const error = await f
          .create(fetch, { apiKey: "k" })
          .generate(baseRequest)
          .catch((e) => e);
        expect(error).toBeInstanceOf(type);
        expect(error.retryable).toBe(retryable);
        expect(error.provider).toBeTruthy();
        if (error instanceof RateLimitError) expect(error.retryAfterMs).toBe(3000);
      }
    });

    it("wraps network failures and invalid bodies as retryable ProviderErrors", async () => {
      const { fetch } = scriptedFetch([
        new TypeError("fetch failed"),
        new Response("not json", { status: 200 }),
      ]);
      const provider = f.create(fetch, { apiKey: "k" });
      const network = await provider.generate(baseRequest).catch((e) => e);
      expect(network).toBeInstanceOf(ProviderError);
      expect(network.retryable).toBe(true);
      const invalid = await provider.generate(baseRequest).catch((e) => e);
      expect(invalid).toBeInstanceOf(ProviderError);
    });

    it("throws AuthError when no API key is configured", async () => {
      const saved = f.envVars.map((v) => [v, process.env[v]] as const);
      for (const v of f.envVars) delete process.env[v];
      try {
        const { fetch, requests } = scriptedFetch([]);
        await expect(f.create(fetch).generate(baseRequest)).rejects.toBeInstanceOf(AuthError);
        expect(requests).toHaveLength(0);
      } finally {
        for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
      }
    });

    it("reads the API key from the environment", async () => {
      const saved = process.env[f.envVars[0]!];
      process.env[f.envVars[0]!] = "env-key";
      try {
        const { fetch, requests } = scriptedFetch([json(f.text("ok", { input: 1, output: 1 }))]);
        await f.create(fetch).generate(baseRequest);
        expect(Object.values(requests[0]!.headers).join(" ")).toContain("env-key");
      } finally {
        if (saved === undefined) delete process.env[f.envVars[0]!];
        else process.env[f.envVars[0]!] = saved;
      }
    });

    it("forwards the abort signal and provider options", async () => {
      const { fetch, requests } = scriptedFetch([json(f.text("ok", { input: 1, output: 1 }))]);
      const controller = new AbortController();
      await f
        .create(fetch, { apiKey: "k" })
        .generate(
          { ...baseRequest, providerOptions: { custom_field: 42 } },
          { signal: controller.signal },
        );
      expect(requests[0]!.signal).toBe(controller.signal);
      expect(requests[0]!.body.custom_field).toBe(42);
    });

    it("works end-to-end with createWeave().extract()", async () => {
      const { fetch } = scriptedFetch([
        json(f.structured({ title: "Soup", steps: ["Boil"] }, "extraction")),
      ]);
      const ai = createWeave({ provider: f.create(fetch, { apiKey: "k" }) });
      const { data, usage } = await ai.extract({
        text: "Soup: boil water.",
        schema: z.object({ title: z.string(), steps: z.array(z.string()) }),
      });
      expect(data).toEqual({ title: "Soup", steps: ["Boil"] });
      expect(usage.provider).toBe(ai.providers[0]!.id);
    });
  });
}
