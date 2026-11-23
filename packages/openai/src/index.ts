/**
 * OpenAI provider for ai-weave (Chat Completions API, no SDK dependency).
 * Also works with OpenAI-compatible servers (Ollama, vLLM, OpenRouter, Groq...) via `baseURL`.
 * @packageDocumentation
 */
import {
  parseToolArguments,
  postJson,
  resolveApiKey,
  type CallOptions,
  type FetchLike,
  type FinishReason,
  type GenerateRequest,
  type GenerateResponse,
  type Message,
  type Provider,
  type ProviderCapabilities,
} from "@ai-weave/core";

export interface OpenAIOptions {
  /** Model id. Default `"gpt-4o-mini"`. */
  model?: string;
  /** API key. Defaults to `OPENAI_API_KEY`. Not required when `baseURL` points to a keyless server. */
  apiKey?: string;
  /** Default `https://api.openai.com/v1`. */
  baseURL?: string;
  /** Provider id used for pricing/usage. Default `"openai"`; set e.g. `"ollama"` for compatible servers. */
  id?: string;
  organization?: string;
  /** Which field carries the token limit. Default `max_completion_tokens`; older compatible servers use `max_tokens`. */
  maxTokensParam?: "max_completion_tokens" | "max_tokens";
  /** Override capabilities, e.g. `{ structuredOutput: false }` for servers without `json_schema`. */
  capabilities?: Partial<ProviderCapabilities>;
  headers?: Record<string, string>;
  fetch?: FetchLike;
}

type OpenAIMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAIResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Converts normalized messages to Chat Completions messages. Exported for testing. */
export function toOpenAIMessages(messages: Message[]): OpenAIMessage[] {
  return messages.map((m): OpenAIMessage => {
    switch (m.role) {
      case "system":
      case "user":
        return { role: m.role, content: m.content };
      case "assistant":
        return {
          role: "assistant",
          content: m.content || (m.toolCalls?.length ? null : ""),
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: "function" as const,
                  function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
                })),
              }
            : {}),
        };
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
  });
}

function finishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "other";
  }
}

/** Builds the Chat Completions request body. Exported for testing. */
export function buildOpenAIBody(
  model: string,
  request: GenerateRequest,
  maxTokensParam: OpenAIOptions["maxTokensParam"] = "max_completion_tokens",
) {
  const body: Record<string, unknown> = { model, messages: toOpenAIMessages(request.messages) };
  if (request.maxTokens !== undefined) body[maxTokensParam] = request.maxTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.stopSequences?.length) body.stop = request.stopSequences;
  if (request.tools?.length) {
    body.tools = request.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.inputSchema,
      },
    }));
    const c = request.toolChoice;
    if (c)
      body.tool_choice =
        typeof c === "string" ? c : { type: "function", function: { name: c.name } };
  }
  if (request.responseFormat) {
    body.response_format = request.responseFormat.schema
      ? {
          type: "json_schema",
          json_schema: {
            name: (request.responseFormat.name ?? "result").replace(/[^a-zA-Z0-9_-]/g, "_"),
            ...(request.responseFormat.description
              ? { description: request.responseFormat.description }
              : {}),
            // Non-strict: strict mode requires every property to be required, which Zod optionals break.
            strict: false,
            schema: request.responseFormat.schema,
          },
        }
      : { type: "json_object" };
  }
  return { ...body, ...request.providerOptions };
}

/**
 * Creates an OpenAI (or OpenAI-compatible) provider.
 *
 * @example
 * ```ts
 * openai({ model: "gpt-4o-mini" });
 * openai({ id: "ollama", baseURL: "http://localhost:11434/v1", model: "llama3.1", apiKey: "ollama" });
 * ```
 */
export function openai(options: OpenAIOptions = {}): Provider {
  const model = options.model ?? "gpt-4o-mini";
  const id = options.id ?? "openai";
  const baseURL = (options.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return {
    id,
    model,
    capabilities: {
      tools: true,
      structuredOutput: true,
      vision: true,
      streaming: false,
      maxContextTokens: 128_000,
      ...options.capabilities,
    },
    async generate(request: GenerateRequest, call?: CallOptions): Promise<GenerateResponse> {
      const apiKey =
        options.baseURL && options.apiKey === undefined
          ? undefined
          : resolveApiKey(id, options.apiKey, ["OPENAI_API_KEY"]);
      const json = await postJson<OpenAIResponse>({
        provider: id,
        url: `${baseURL}/chat/completions`,
        headers: {
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          ...(options.organization ? { "openai-organization": options.organization } : {}),
          ...options.headers,
        },
        body: buildOpenAIBody(model, request, options.maxTokensParam),
        fetch: options.fetch,
        signal: call?.signal,
      });
      const choice = json.choices?.[0];
      const message = choice?.message;
      let reason = finishReason(choice?.finish_reason);
      if (message?.refusal) reason = "content_filter";
      return {
        text: message?.content ?? "",
        toolCalls: (message?.tool_calls ?? []).map((c) => ({
          id: c.id,
          name: c.function?.name ?? "",
          input: parseToolArguments(c.function?.arguments),
        })),
        finishReason: reason,
        usage: {
          inputTokens: json.usage?.prompt_tokens ?? 0,
          outputTokens: json.usage?.completion_tokens ?? 0,
        },
        model: json.model,
        raw: json,
      };
    },
  };
}
