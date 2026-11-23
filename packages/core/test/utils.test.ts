import { describe, expect, it, vi } from "vitest";
import {
  AbortError,
  AllProvidersFailedError,
  AuthError,
  ConfigError,
  ContextLengthError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  backoffDelay,
  errorFromStatus,
  estimateCost,
  findPrice,
  formatIssues,
  getEnv,
  isRetryable,
  parseJsonLoose,
  parseRetryAfter,
  prepareSchema,
  randomId,
  sleep,
  toJsonSchema,
  truncate,
  withRetry,
  withTimeout,
  DEFAULT_PRICES,
} from "@ai-weave/core";
import { z } from "zod";

describe("errors", () => {
  it("maps HTTP statuses to the taxonomy", () => {
    const opts = { provider: "x" };
    expect(errorFromStatus(401, "bad key", opts)).toBeInstanceOf(AuthError);
    expect(errorFromStatus(403, "forbidden", opts)).toBeInstanceOf(AuthError);
    expect(
      errorFromStatus(400, "API key not valid. Please pass a valid API key.", opts),
    ).toBeInstanceOf(AuthError);
    const rl = errorFromStatus(429, "slow down", { ...opts, retryAfterMs: 1000 });
    expect(rl).toBeInstanceOf(RateLimitError);
    expect(rl.retryable).toBe(true);
    expect((rl as RateLimitError).retryAfterMs).toBe(1000);
    expect(errorFromStatus(429, "You exceeded your current quota", opts).retryable).toBe(false);
    expect(errorFromStatus(529, "overloaded", opts)).toBeInstanceOf(RateLimitError);
    expect(errorFromStatus(400, "prompt is too long: 300000 tokens", opts)).toBeInstanceOf(
      ContextLengthError,
    );
    expect(errorFromStatus(408, "timeout", opts)).toBeInstanceOf(TimeoutError);
    const s500 = errorFromStatus(500, "boom", opts);
    expect(s500).toBeInstanceOf(ProviderError);
    expect(s500.retryable).toBe(true);
    expect(errorFromStatus(400, "bad request", opts).retryable).toBe(false);
    expect(s500.message).toBe("x 500: boom");
    expect(s500.provider).toBe("x");
    expect(s500.status).toBe(500);
  });

  it("isRetryable only for retryable weave errors", () => {
    expect(isRetryable(new ProviderError("x"))).toBe(true);
    expect(isRetryable(new AuthError("x"))).toBe(false);
    expect(isRetryable(new Error("x"))).toBe(false);
  });

  it("parses Retry-After", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("garbage")).toBeUndefined();
    const now = Date.parse("2025-01-01T00:00:00Z");
    expect(parseRetryAfter("Wed, 01 Jan 2025 00:00:05 GMT", now)).toBe(5000);
  });

  it("AllProvidersFailedError summarizes errors", () => {
    const e = new AllProvidersFailedError([new ProviderError("a", { provider: "p1" }), "b"]);
    expect(e.message).toContain("p1: a");
    expect(e.message).toContain("b");
    expect(e.errors).toHaveLength(2);
  });
});

describe("withRetry", () => {
  it("retries retryable errors then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError("5xx", { status: 500 }))
      .mockResolvedValueOnce("ok");
    const onRetry = vi.fn();
    await expect(withRetry(fn, { baseDelayMs: 1, onRetry })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("does not retry non-retryable errors", async () => {
    const fn = vi.fn().mockRejectedValue(new AuthError("no"));
    await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toBeInstanceOf(AuthError);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("gives up after maxRetries", async () => {
    const fn = vi.fn().mockRejectedValue(new ProviderError("x", { status: 503 }));
    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1 })).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("honors retryAfterMs capped by maxDelayMs", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RateLimitError("rl", { retryAfterMs: 60_000 }))
      .mockResolvedValueOnce("ok");
    const onRetry = vi.fn();
    await withRetry(fn, { baseDelayMs: 1, maxDelayMs: 5, onRetry });
    expect(onRetry.mock.calls[0]![2]).toBe(5);
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(withRetry(async () => "x", { signal: controller.signal })).rejects.toBeInstanceOf(
      AbortError,
    );
  });

  it("backoffDelay grows exponentially with jitter and is capped", () => {
    expect(backoffDelay(0, { baseDelayMs: 100 }, () => 0)).toBe(50);
    expect(backoffDelay(0, { baseDelayMs: 100 }, () => 1)).toBe(100);
    expect(backoffDelay(3, { baseDelayMs: 100 }, () => 1)).toBe(800);
    expect(backoffDelay(10, { baseDelayMs: 100, maxDelayMs: 1000 }, () => 1)).toBe(1000);
  });
});

describe("withTimeout / sleep", () => {
  it("throws TimeoutError when the call is too slow", async () => {
    await expect(withTimeout((signal) => sleep(1000, signal), 10)).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });

  it("throws AbortError when the parent aborts", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await expect(
      withTimeout((signal) => sleep(1000, signal), 1000, controller.signal),
    ).rejects.toBeInstanceOf(AbortError);
  });

  it("passes through results and other errors", async () => {
    await expect(withTimeout(async () => 1, 100)).resolves.toBe(1);
    await expect(withTimeout(async () => Promise.reject(new Error("x")), 0)).rejects.toThrow("x");
  });

  it("rejects immediately for an already-aborted signal", async () => {
    const c = new AbortController();
    c.abort();
    await expect(sleep(10, c.signal)).rejects.toBeInstanceOf(AbortError);
    await expect(withTimeout(async () => 1, 10, c.signal)).rejects.toBeInstanceOf(AbortError);
  });
});

describe("parseJsonLoose", () => {
  it("handles plain JSON, fences and prose", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJsonLoose('Sure! Here it is: {"a":3} Hope that helps')).toEqual({ a: 3 });
    expect(parseJsonLoose("result: [1,2]")).toEqual([1, 2]);
    expect(() => parseJsonLoose("no json here")).toThrow();
    expect(() => parseJsonLoose("```json\n{bad}\n```")).toThrow();
  });
});

describe("misc utils", () => {
  it("truncate prefers paragraph boundaries", () => {
    const text = "a".repeat(90) + "\n\n" + "b".repeat(50);
    expect(truncate("short", 10)).toEqual({ text: "short", truncated: false });
    expect(truncate(text, 100)).toEqual({ text: "a".repeat(90), truncated: true });
    expect(truncate("x".repeat(200), 100).text).toHaveLength(100);
  });

  it("randomId and getEnv", () => {
    expect(randomId("call")).toMatch(/^call_[a-z0-9]+$/);
    process.env.AI_WEAVE_TEST_VAR = "yes";
    expect(getEnv("AI_WEAVE_TEST_VAR")).toBe("yes");
    expect(getEnv("AI_WEAVE_MISSING_VAR")).toBeUndefined();
  });
});

describe("pricing", () => {
  it("matches the longest prefix", () => {
    expect(findPrice(DEFAULT_PRICES, "anthropic", "claude-opus-4-5-20251101")).toEqual({
      input: 5,
      output: 25,
    });
    expect(findPrice(DEFAULT_PRICES, "anthropic", "claude-opus-4-1")).toEqual({
      input: 15,
      output: 75,
    });
    expect(findPrice(DEFAULT_PRICES, "openai", "gpt-4o-mini-2024-07-18")).toEqual({
      input: 0.15,
      output: 0.6,
    });
    expect(findPrice(DEFAULT_PRICES, "openai", "unknown")).toBeUndefined();
  });

  it("estimates cost", () => {
    expect(estimateCost(DEFAULT_PRICES, "openai", "gpt-4o", 1_000_000, 1_000_000)).toBe(12.5);
    expect(estimateCost(DEFAULT_PRICES, "x", "y", 1, 1)).toBeUndefined();
  });
});

describe("schema", () => {
  it("converts zod to JSON schema without $schema", () => {
    const json = toJsonSchema(z.object({ a: z.string(), b: z.number().optional() }));
    expect(json.$schema).toBeUndefined();
    expect(json.type).toBe("object");
    expect(json.required).toEqual(["a"]);
  });

  it("wraps non-object roots", () => {
    expect(prepareSchema(z.object({ a: z.string() })).wrapped).toBe(false);
    const wrapped = prepareSchema(z.array(z.string()));
    expect(wrapped.wrapped).toBe(true);
    expect(wrapped.jsonSchema).toMatchObject({ type: "object", required: ["value"] });
  });

  it("formats issues with paths", () => {
    const result = z.object({ a: z.object({ b: z.number() }) }).safeParse({ a: { b: "x" } });
    expect(result.success).toBe(false);
    if (!result.success) expect(formatIssues(result.error)[0]).toMatch(/^a\.b: /);
    const root = z.string().safeParse(1);
    if (!root.success) expect(formatIssues(root.error)[0]).toMatch(/^\(root\): /);
  });

  it("ConfigError is not retryable", () => {
    expect(new ConfigError("x").retryable).toBe(false);
  });
});
