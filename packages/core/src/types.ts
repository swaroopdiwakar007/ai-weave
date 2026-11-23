/**
 * Normalized types shared by every provider adapter.
 * @module
 */

/** A JSON Schema object (draft-07 compatible subset). */
export type JsonSchema = Record<string, unknown>;

/** A tool call requested by the model. */
export interface ToolCall {
  /** Provider-assigned (or generated) id used to correlate the result. */
  id: string;
  name: string;
  /** Parsed arguments object. */
  input: unknown;
}

/** A normalized chat message. */
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | {
      role: "tool";
      toolCallId: string;
      toolName: string;
      /** Tool output, serialized as text (JSON recommended). */
      content: string;
      isError?: boolean;
    };

/** A tool the model may call. */
export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema of the tool input. Must describe an object. */
  inputSchema: JsonSchema;
}

/** How the model should choose tools. */
export type ToolChoice = "auto" | "none" | "required" | { name: string };

/** Ask the provider for JSON output, optionally constrained by a schema. */
export interface ResponseFormat {
  type: "json";
  /** JSON Schema of the expected object. The root must be `type: "object"`. */
  schema?: JsonSchema;
  /** Name for the schema (used by some providers). */
  name?: string;
  description?: string;
}

/** A request sent to a {@link Provider}. */
export interface GenerateRequest {
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  /**
   * When set, the provider must return JSON (as a string in {@link GenerateResponse.text}).
   * Adapters only receive this when `capabilities.structuredOutput` is true.
   */
  responseFormat?: ResponseFormat;
  stopSequences?: string[];
  /** Vendor-specific request fields, merged into the request body as-is. */
  providerOptions?: Record<string, unknown>;
}

/** Token usage reported by a provider for a single call. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Why the model stopped generating. */
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "error" | "other";

/** A normalized provider response. */
export interface GenerateResponse {
  text: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: TokenUsage;
  /** The model that actually served the request, if reported. */
  model?: string;
  /** Raw provider payload, for debugging. */
  raw?: unknown;
}

/** Per-call options passed to providers. */
export interface CallOptions {
  signal?: AbortSignal;
}

/** Feature flags used by the engine to pick the best strategy. */
export interface ProviderCapabilities {
  tools: boolean;
  /** Supports JSON output constrained by a schema (natively or via forced tool use). */
  structuredOutput: boolean;
  vision: boolean;
  streaming: boolean;
  /** Approximate maximum context window, in tokens. */
  maxContextTokens?: number;
}

/**
 * A model provider. Implement this to add a new vendor.
 * Adapters must throw errors from `@ai-weave/core` (`AuthError`, `RateLimitError`, ...).
 */
export interface Provider {
  /** Vendor id, e.g. `"anthropic"`. */
  readonly id: string;
  /** Model id, e.g. `"claude-sonnet-4-5"`. */
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  generate(request: GenerateRequest, options?: CallOptions): Promise<GenerateResponse>;
}

/** Usage and cost reported for a task (aggregated across all provider calls it made). */
export interface Usage {
  /** Task that produced the usage, e.g. `"extract"`. */
  task: string;
  /** Provider that served the final call. */
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Estimated cost in USD, or `undefined` if the model is not in the price table. */
  costUsd: number | undefined;
  latencyMs: number;
  /** Number of provider calls (includes repairs; excludes failed attempts). */
  calls: number;
  /** True if served from cache. Always false until caching ships. */
  cached: boolean;
}

/** A fetched and cleaned web page, produced by a {@link Fetcher}. */
export interface FetchedPage {
  /** Final URL after redirects. */
  url: string;
  title?: string;
  /** Main content as markdown/plain text. */
  content: string;
  /** All schema.org JSON-LD nodes found on the page (flattened, `@graph` expanded). */
  structuredData: Record<string, unknown>[];
  contentType?: string;
}

/** Fetches a URL and turns it into a {@link FetchedPage}. See `@ai-weave/web`. */
export interface Fetcher {
  fetch(url: string, options?: CallOptions): Promise<FetchedPage>;
}
