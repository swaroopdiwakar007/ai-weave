import { AbortError, AllProvidersFailedError, ConfigError, isRetryable } from "./errors.js";
import { DEFAULT_PRICES, estimateCost, type PriceTable } from "./pricing.js";
import type {
  Fetcher,
  GenerateRequest,
  GenerateResponse,
  Message,
  Provider,
  Usage,
} from "./types.js";
import { throwIfAborted, withRetry, withTimeout, type RetryOptions } from "./utils.js";

/** Lifecycle hooks for logging, tracing and cost tracking. Hook errors are swallowed. */
export interface WeaveHooks {
  /** Called before every provider attempt (including retries and fallbacks). */
  onRequest?(event: {
    task: string;
    provider: string;
    model: string;
    request: GenerateRequest;
    attempt: number;
  }): void;
  /** Called after every successful provider call. */
  onResponse?(event: {
    task: string;
    provider: string;
    model: string;
    response: GenerateResponse;
    latencyMs: number;
  }): void;
  /** Called on every failed provider attempt. */
  onError?(event: {
    task: string;
    provider: string;
    model: string;
    error: unknown;
    attempt: number;
    willRetry: boolean;
  }): void;
  /** Called once per completed task with aggregated usage. */
  onUsage?(usage: Usage): void;
}

/** Configuration for {@link createWeave}. */
export interface WeaveConfig extends WeaveHooks {
  /** Primary provider. */
  provider: Provider;
  /** Providers tried in order when the primary fails (after its retries). */
  fallback?: Provider[];
  /** Retry policy per provider, or `false` to disable. Default: 2 retries, 500ms base. */
  retry?: RetryOptions | false;
  /** Timeout per provider call in ms. Default 60000. Use 0 to disable. */
  timeoutMs?: number;
  /** Used by `extract({ url })`. Use `webFetcher()` from `@ai-weave/web`. */
  fetcher?: Fetcher;
  /** Price overrides/additions merged over the defaults (USD per 1M tokens). */
  pricing?: PriceTable;
}

/** Provider-specific request options keyed by provider id, e.g. `{ openai: { seed: 1 } }`. */
export type ProviderOptionsMap = Record<string, Record<string, unknown>>;

/** Options accepted by every task. */
export interface BaseTaskOptions {
  signal?: AbortSignal;
  /** Vendor-specific request fields keyed by provider id. Only the active provider's entry is sent. */
  providerOptions?: ProviderOptionsMap;
}

/** Resolved runtime context shared by all tasks. */
export interface WeaveContext {
  providers: Provider[];
  retry: RetryOptions;
  timeoutMs: number;
  fetcher?: Fetcher;
  prices: PriceTable;
  hooks: WeaveHooks;
}

export function resolveConfig(config: WeaveConfig): WeaveContext {
  if (!config || !config.provider) {
    throw new ConfigError(
      "createWeave: `provider` is required, e.g. anthropic() from @ai-weave/anthropic",
    );
  }
  return {
    providers: [config.provider, ...(config.fallback ?? [])],
    retry: config.retry === false ? { maxRetries: 0 } : { maxRetries: 2, ...config.retry },
    timeoutMs: config.timeoutMs ?? 60_000,
    fetcher: config.fetcher,
    prices: { ...DEFAULT_PRICES, ...config.pricing },
    hooks: {
      onRequest: config.onRequest,
      onResponse: config.onResponse,
      onError: config.onError,
      onUsage: config.onUsage,
    },
  };
}

function safe<A>(fn: ((arg: A) => void) | undefined, arg: A): void {
  if (!fn) return;
  try {
    fn(arg);
  } catch {
    // Hooks must never break a request.
  }
}

/**
 * Tracks one task execution: calls providers with retry, timeout and fallback, and
 * aggregates usage across calls.
 */
export class TaskRun {
  private inputTokens = 0;
  private outputTokens = 0;
  private cost: number | undefined = 0;
  private calls = 0;
  private lastProvider: Provider;
  private readonly start = Date.now();

  constructor(
    private readonly ctx: WeaveContext,
    readonly task: string,
    private readonly signal?: AbortSignal,
  ) {
    this.lastProvider = ctx.providers[0]!;
  }

  /**
   * Sends a request built for each provider in turn until one succeeds.
   * `build` receives the provider so the request can adapt to its capabilities.
   */
  async call(
    build: (provider: Provider) => GenerateRequest,
  ): Promise<{ response: GenerateResponse; provider: Provider }> {
    const errors: unknown[] = [];
    const { providers, hooks, retry } = this.ctx;
    for (const provider of providers) {
      throwIfAborted(this.signal);
      const request = build(provider);
      try {
        const started = Date.now();
        const response = await withRetry(
          async (attempt) => {
            safe(hooks.onRequest, {
              task: this.task,
              provider: provider.id,
              model: provider.model,
              request,
              attempt,
            });
            try {
              return await withTimeout(
                (signal) => provider.generate(request, { signal }),
                this.ctx.timeoutMs,
                this.signal,
                `${provider.id} request`,
              );
            } catch (error) {
              safe(hooks.onError, {
                task: this.task,
                provider: provider.id,
                model: provider.model,
                error,
                attempt,
                willRetry: isRetryable(error) && attempt < (retry.maxRetries ?? 2),
              });
              throw error;
            }
          },
          { ...retry, signal: this.signal },
        );
        this.record(provider, response);
        safe(hooks.onResponse, {
          task: this.task,
          provider: provider.id,
          model: provider.model,
          response,
          latencyMs: Date.now() - started,
        });
        return { response, provider };
      } catch (error) {
        if (error instanceof AbortError || error instanceof ConfigError) throw error;
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    throw new AllProvidersFailedError(errors);
  }

  private record(provider: Provider, response: GenerateResponse): void {
    this.calls++;
    this.lastProvider = provider;
    const { inputTokens, outputTokens } = response.usage;
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
    const callCost = estimateCost(
      this.ctx.prices,
      provider.id,
      provider.model,
      inputTokens,
      outputTokens,
    );
    this.cost =
      this.cost === undefined || callCost === undefined ? undefined : this.cost + callCost;
  }

  /** Aggregated usage so far. */
  usage(): Usage {
    return {
      task: this.task,
      provider: this.lastProvider.id,
      model: this.lastProvider.model,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      costUsd: this.cost,
      latencyMs: Date.now() - this.start,
      calls: this.calls,
      cached: false,
    };
  }

  /** Emits `onUsage` and returns the final usage. */
  finish(): Usage {
    const usage = this.usage();
    safe(this.ctx.hooks.onUsage, usage);
    return usage;
  }
}

/** Builds a message list from `prompt` / `messages` / `system`. */
export function buildMessages(options: {
  prompt?: string;
  messages?: Message[];
  system?: string;
}): Message[] {
  const messages: Message[] = [];
  if (options.system) messages.push({ role: "system", content: options.system });
  if (options.messages) messages.push(...options.messages);
  if (options.prompt !== undefined) messages.push({ role: "user", content: options.prompt });
  if (!messages.some((m) => m.role !== "system")) {
    throw new ConfigError("Provide `prompt` or `messages`");
  }
  return messages;
}

/** Picks the entry for a provider from a {@link ProviderOptionsMap}. */
export function optionsFor(
  map: ProviderOptionsMap | undefined,
  provider: Provider,
): Record<string, unknown> | undefined {
  return map?.[provider.id];
}
