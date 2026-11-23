import { AbortError, TimeoutError, WeaveError, isRetryable, RateLimitError } from "./errors.js";

/** Reads an environment variable in Node, Bun, Deno (with --allow-env) and edge runtimes. */
export function getEnv(name: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  try {
    return g.process?.env?.[name] || undefined;
  } catch {
    return undefined;
  }
}

/** Throws {@link AbortError} if the signal is aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError("Operation aborted", { cause: signal.reason });
}

/** Sleeps for `ms`, rejecting with {@link AbortError} if `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted)
      return reject(new AbortError("Operation aborted", { cause: signal.reason }));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError("Operation aborted", { cause: signal?.reason }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs `fn` with a signal that aborts when the parent signal aborts or `timeoutMs` elapses.
 * Timeouts surface as {@link TimeoutError}; parent aborts as {@link AbortError}.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | undefined,
  parent?: AbortSignal,
  label = "Request",
): Promise<T> {
  throwIfAborted(parent);
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", onAbort, { once: true });
  const timer =
    timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort(new Error("timeout"));
        }, timeoutMs)
      : undefined;
  try {
    return await fn(controller.signal);
  } catch (error) {
    if (timedOut)
      throw new TimeoutError(`${label} timed out after ${timeoutMs}ms`, { cause: error });
    if (parent?.aborted) throw new AbortError("Operation aborted", { cause: parent.reason });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener("abort", onAbort);
  }
}

/** Retry policy. */
export interface RetryOptions {
  /** Retries after the first attempt. Default 2. */
  maxRetries?: number;
  /** Base delay for exponential backoff, in ms. Default 500. */
  baseDelayMs?: number;
  /** Maximum delay between attempts, in ms. Default 8000. */
  maxDelayMs?: number;
}

/** Computes the backoff delay (full jitter) for a 0-based retry index. */
export function backoffDelay(
  retry: number,
  options: RetryOptions = {},
  random = Math.random,
): number {
  const base = options.baseDelayMs ?? 500;
  const max = options.maxDelayMs ?? 8000;
  const exp = Math.min(max, base * 2 ** retry);
  return Math.round(exp / 2 + random() * (exp / 2));
}

/**
 * Calls `fn` and retries on retryable {@link WeaveError}s with exponential backoff and jitter.
 * Honors `RateLimitError.retryAfterMs` (capped at `maxDelayMs`).
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions & {
    signal?: AbortSignal;
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 2;
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(options.signal);
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= maxRetries || !isRetryable(error)) throw error;
      let delay = backoffDelay(attempt, options);
      if (error instanceof RateLimitError && error.retryAfterMs !== undefined) {
        delay = Math.min(Math.max(delay, error.retryAfterMs), options.maxDelayMs ?? 8000);
      }
      options.onRetry?.(error, attempt + 1, delay);
      await sleep(delay, options.signal);
    }
  }
}

/** Extracts a JSON value from model output (handles code fences and surrounding prose). */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through
    }
  }
  const start = trimmed.search(/[[{]/);
  if (start >= 0) {
    const open = trimmed[start];
    const close = open === "{" ? "}" : "]";
    const end = trimmed.lastIndexOf(close);
    if (end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
  }
  throw new WeaveError("Model output is not valid JSON");
}

/** Truncates text to `maxChars`, preferring a paragraph boundary. */
export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  let cut = text.lastIndexOf("\n\n", maxChars);
  if (cut < maxChars * 0.8) cut = maxChars;
  return { text: text.slice(0, cut), truncated: true };
}

/** Generates a short random id. */
export function randomId(prefix = "id"): string {
  const c = globalThis.crypto as Crypto | undefined;
  const rand = c?.randomUUID
    ? c.randomUUID().replace(/-/g, "").slice(0, 16)
    : Math.random().toString(36).slice(2, 18);
  return `${prefix}_${rand}`;
}
