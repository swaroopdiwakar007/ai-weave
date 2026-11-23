/**
 * Error taxonomy. Provider adapters map vendor errors onto these classes so retry
 * and fallback logic behaves the same way for every provider.
 * @module
 */

export interface WeaveErrorOptions {
  cause?: unknown;
  /** Provider id that raised the error. */
  provider?: string;
  /** HTTP status, if any. */
  status?: number;
}

/** Base class for every error thrown by ai-weave. */
export class WeaveError extends Error {
  override readonly name: string = "WeaveError";
  readonly provider?: string;
  readonly status?: number;
  /** Whether retrying the same call might succeed. */
  readonly retryable: boolean = false;

  constructor(message: string, options: WeaveErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.provider = options.provider;
    this.status = options.status;
  }
}

/** Invalid configuration or arguments. Never retried. */
export class ConfigError extends WeaveError {
  override readonly name = "ConfigError";
}

/** Generic provider failure (5xx, network, malformed response...). */
export class ProviderError extends WeaveError {
  override readonly name: string = "ProviderError";
  override readonly retryable: boolean;
  constructor(message: string, options: WeaveErrorOptions & { retryable?: boolean } = {}) {
    super(message, options);
    this.retryable = options.retryable ?? (options.status === undefined || options.status >= 500);
  }
}

/** Missing or invalid credentials. */
export class AuthError extends ProviderError {
  override readonly name = "AuthError";
  constructor(message: string, options: WeaveErrorOptions = {}) {
    super(message, { ...options, retryable: false });
  }
}

/** Rate limited or overloaded. Retryable unless the quota is exhausted. */
export class RateLimitError extends ProviderError {
  override readonly name = "RateLimitError";
  /** Server-suggested wait before retrying, in ms. */
  readonly retryAfterMs?: number;
  constructor(
    message: string,
    options: WeaveErrorOptions & { retryAfterMs?: number; retryable?: boolean } = {},
  ) {
    super(message, { ...options, retryable: options.retryable ?? true });
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** The prompt does not fit in the model's context window. */
export class ContextLengthError extends ProviderError {
  override readonly name = "ContextLengthError";
  constructor(message: string, options: WeaveErrorOptions = {}) {
    super(message, { ...options, retryable: false });
  }
}

/** The provider refused or blocked the content. */
export class ContentFilterError extends ProviderError {
  override readonly name = "ContentFilterError";
  constructor(message: string, options: WeaveErrorOptions = {}) {
    super(message, { ...options, retryable: false });
  }
}

/** A single call exceeded its timeout. Retryable. */
export class TimeoutError extends ProviderError {
  override readonly name = "TimeoutError";
  constructor(message: string, options: WeaveErrorOptions = {}) {
    super(message, { ...options, retryable: true });
  }
}

/** The caller aborted the operation via `AbortSignal`. Never retried. */
export class AbortError extends WeaveError {
  override readonly name = "AbortError";
}

/** A model output could not be validated against the schema, even after repairs. */
export class ValidationError extends WeaveError {
  override readonly name = "ValidationError";
  /** Human-readable validation issues from the last attempt. */
  readonly issues: string[];
  /** Raw model output from the last attempt. */
  readonly rawOutput: string;
  constructor(
    message: string,
    options: WeaveErrorOptions & { issues: string[]; rawOutput: string },
  ) {
    super(message, options);
    this.issues = options.issues;
    this.rawOutput = options.rawOutput;
  }
}

/** Fetching a URL failed or was blocked (SSRF guard, size limit, content type...). */
export class FetchError extends WeaveError {
  override readonly name = "FetchError";
  readonly url?: string;
  constructor(message: string, options: WeaveErrorOptions & { url?: string } = {}) {
    super(message, options);
    this.url = options.url;
  }
}

/** Every provider in the fallback chain failed. `errors` holds each failure in order. */
export class AllProvidersFailedError extends WeaveError {
  override readonly name = "AllProvidersFailedError";
  readonly errors: unknown[];
  constructor(errors: unknown[]) {
    const summary = errors
      .map((e) =>
        e instanceof Error ? `${(e as WeaveError).provider ?? "?"}: ${e.message}` : String(e),
      )
      .join("; ");
    super(`All providers failed: ${summary}`, { cause: errors[errors.length - 1] });
    this.errors = errors;
  }
}

/** True if retrying the same call may succeed. */
export function isRetryable(error: unknown): boolean {
  return error instanceof WeaveError && error.retryable;
}

/**
 * Maps an HTTP error response to the error taxonomy. Shared by provider adapters.
 * `message` should be the vendor's error message when available.
 */
export function errorFromStatus(
  status: number,
  message: string,
  options: { provider: string; retryAfterMs?: number; cause?: unknown },
): ProviderError {
  const base = { provider: options.provider, status, cause: options.cause };
  const text = `${options.provider} ${status}: ${message}`;
  if (status === 401 || status === 403) return new AuthError(text, base);
  if (status === 429) {
    const quota = /quota|billing|insufficient/i.test(message);
    return new RateLimitError(text, {
      ...base,
      retryAfterMs: options.retryAfterMs,
      retryable: !quota,
    });
  }
  if (status === 529 || status === 503) {
    return new RateLimitError(text, { ...base, retryAfterMs: options.retryAfterMs });
  }
  if (status === 400 && /api.key.not.valid|invalid.api.key|API_KEY_INVALID/i.test(message)) {
    return new AuthError(text, base);
  }
  if (
    /context.length|context window|too long|too many tokens|maximum context|maximum number of tokens/i.test(
      message,
    )
  ) {
    return new ContextLengthError(text, base);
  }
  if (status === 408) return new TimeoutError(text, base);
  return new ProviderError(text, { ...base, retryable: status >= 500 });
}

/** Parses a `Retry-After` header (seconds or HTTP date) to milliseconds. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
