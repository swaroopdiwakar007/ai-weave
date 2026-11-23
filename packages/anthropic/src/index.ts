/**
 * Anthropic Claude provider for ai-weave (Messages API, no SDK dependency).
 * @packageDocumentation
 */
import {
  postJson,
  resolveApiKey,
  type CallOptions,
  type FetchLike,
  type FinishReason,
  type GenerateRequest,
  type GenerateResponse,
  type Message,
  type Provider,
} from "@ai-weave/core";

export interface AnthropicOptions {
  /** Model id. Default `"claude-sonnet-4-5"`. */
  model?: string;
  /** API key. Defaults to `ANTHROPIC_API_KEY`. */
  apiKey?: string;
  /** Default `https://api.anthropic.com`. */
  baseURL?: string;
  /** `max_tokens` when the request does not set one (required by the API). Default 4096. */
  defaultMaxTokens?: number;
  /** Extra headers, e.g. `anthropic-beta`. */
  headers?: Record<string, string>;
  /** Custom fetch (testing, proxies). */
  fetch?: FetchLike;
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: Block[];
}

interface AnthropicResponse {
  model?: string;
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Converts normalized messages to Anthropic's `system` + `messages`. Exported for testing. */
export function toAnthropicMessages(messages: Message[]): {
  system?: string;
  messages: AnthropicMessage[];
} {
  const system: string[] = [];
  const out: AnthropicMessage[] = [];
  const push = (role: AnthropicMessage["role"], blocks: Block[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    switch (m.role) {
      case "system":
        system.push(m.content);
        break;
      case "user":
        push("user", [{ type: "text", text: m.content }]);
        break;
      case "assistant": {
        const blocks: Block[] = m.content ? [{ type: "text", text: m.content }] : [];
        for (const call of m.toolCalls ?? []) {
          blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input ?? {} });
        }
        push("assistant", blocks.length ? blocks : [{ type: "text", text: "" }]);
        break;
      }
      case "tool":
        push("user", [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId,
            content: m.content,
            ...(m.isError ? { is_error: true } : {}),
          },
        ]);
        break;
    }
  }
  return { system: system.length ? system.join("\n\n") : undefined, messages: out };
}

function finishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return "other";
  }
}

/** Builds the Messages API request body. Exported for testing. */
export function buildAnthropicBody(
  model: string,
  request: GenerateRequest,
  defaultMaxTokens: number,
) {
  const { system, messages } = toAnthropicMessages(request.messages);
  const body: Record<string, unknown> = {
    model,
    max_tokens: request.maxTokens ?? defaultMaxTokens,
    messages,
  };
  if (system) body.system = system;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.stopSequences?.length) body.stop_sequences = request.stopSequences;

  const tools = (request.tools ?? []).map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    input_schema: t.inputSchema,
  }));
  if (request.responseFormat) {
    // Structured output via a forced tool call; the tool input is the JSON result.
    const name = request.responseFormat.name ?? "result";
    tools.push({
      name,
      description: request.responseFormat.description ?? "Return the result as structured data.",
      input_schema: request.responseFormat.schema ?? { type: "object" },
    });
    body.tool_choice = { type: "tool", name };
  } else if (request.toolChoice && tools.length) {
    const c = request.toolChoice;
    body.tool_choice =
      c === "auto"
        ? { type: "auto" }
        : c === "required"
          ? { type: "any" }
          : c === "none"
            ? { type: "none" }
            : { type: "tool", name: c.name };
  }
  if (tools.length) body.tools = tools;
  return { ...body, ...request.providerOptions };
}

/**
 * Creates an Anthropic provider.
 *
 * @example
 * ```ts
 * const ai = createWeave({ provider: anthropic({ model: "claude-sonnet-4-5" }) });
 * ```
 */
export function anthropic(options: AnthropicOptions = {}): Provider {
  const model = options.model ?? "claude-sonnet-4-5";
  const baseURL = (options.baseURL ?? "https://api.anthropic.com").replace(/\/+$/, "");
  return {
    id: "anthropic",
    model,
    capabilities: {
      tools: true,
      structuredOutput: true,
      vision: true,
      streaming: false,
      maxContextTokens: 200_000,
    },
    async generate(request: GenerateRequest, call?: CallOptions): Promise<GenerateResponse> {
      const apiKey = resolveApiKey("anthropic", options.apiKey, ["ANTHROPIC_API_KEY"]);
      const json = await postJson<AnthropicResponse>({
        provider: "anthropic",
        url: `${baseURL}/v1/messages`,
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", ...options.headers },
        body: buildAnthropicBody(model, request, options.defaultMaxTokens ?? 4096),
        fetch: options.fetch,
        signal: call?.signal,
      });
      const blocks = json.content ?? [];
      let text = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      let toolCalls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id ?? "", name: b.name ?? "", input: b.input ?? {} }));
      let reason = finishReason(json.stop_reason);
      if (request.responseFormat) {
        const name = request.responseFormat.name ?? "result";
        const result = toolCalls.find((c) => c.name === name);
        if (result) {
          text = JSON.stringify(result.input);
          toolCalls = [];
          if (reason === "tool_calls") reason = "stop";
        }
      }
      return {
        text,
        toolCalls,
        finishReason: reason,
        usage: {
          inputTokens: json.usage?.input_tokens ?? 0,
          outputTokens: json.usage?.output_tokens ?? 0,
        },
        model: json.model,
        raw: json,
      };
    },
  };
}
