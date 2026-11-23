/**
 * Helpers for writing provider adapters on top of `fetch`.
 * @module
 */
import { AuthError, ProviderError, errorFromStatus, parseRetryAfter } from "./errors.js";
import { getEnv } from "./utils.js";

/** A `fetch`-compatible function. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Returns `explicit` or the first set env var, or throws {@link AuthError}. */
export function resolveApiKey(
  provider: string,
  explicit: string | undefined,
  envNames: string[],
): string {
  const key = explicit ?? envNames.map(getEnv).find(Boolean);
  if (!key) {
    throw new AuthError(
      `${provider}: missing API key. Pass \`apiKey\` or set ${envNames.join(" or ")}.`,
      {
        provider,
      },
    );
  }
  return key;
}

function errorMessage(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const err = (json as { error?: unknown }).error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; type?: unknown; code?: unknown; status?: unknown };
    const parts = [e.type ?? e.code ?? e.status, e.message].filter((p) => typeof p === "string");
    if (parts.length) return parts.join(": ");
  }
  return undefined;
}

/**
 * POSTs JSON and returns the parsed JSON body. Non-2xx responses become typed errors
 * (`AuthError`, `RateLimitError`, `ContextLengthError`, `ProviderError`); network failures
 * become retryable `ProviderError`s.
 */
export async function postJson<T>(options: {
  provider: string;
  url: string;
  headers?: Record<string, string>;
  body: unknown;
  fetch?: FetchLike;
  signal?: AbortSignal;
}): Promise<T> {
  const doFetch = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
  if (!doFetch)
    throw new ProviderError("No fetch implementation available", { provider: options.provider });
  let response: Response;
  try {
    response = await doFetch(options.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...options.headers },
      body: JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderError(`${options.provider} network error: ${message}`, {
      provider: options.provider,
      cause: error,
      retryable: true,
    });
  }
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!response.ok) {
    const message =
      errorMessage(json) ?? (text.slice(0, 500) || response.statusText || "request failed");
    throw errorFromStatus(response.status, message, {
      provider: options.provider,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      cause: json ?? text,
    });
  }
  if (json === undefined) {
    throw new ProviderError(`${options.provider}: response is not valid JSON`, {
      provider: options.provider,
      status: response.status,
      retryable: true,
    });
  }
  return json as T;
}

/** Parses a tool-call arguments string; returns `{}` for empty input and the raw string if invalid. */
export function parseToolArguments(args: string | undefined): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}
