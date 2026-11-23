/**
 * Google Gemini provider for ai-weave (Gemini API `generateContent`, no SDK dependency).
 * @packageDocumentation
 */
import {
  ContentFilterError,
  postJson,
  randomId,
  resolveApiKey,
  type CallOptions,
  type FetchLike,
  type FinishReason,
  type GenerateRequest,
  type GenerateResponse,
  type Message,
  type Provider,
} from "@ai-weave/core";

export interface GeminiOptions {
  /** Model id. Default `"gemini-2.5-flash"`. */
  model?: string;
  /** API key. Defaults to `GEMINI_API_KEY`, then `GOOGLE_API_KEY`. */
  apiKey?: string;
  /** Default `https://generativelanguage.googleapis.com/v1beta`. */
  baseURL?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
}

type Part =
  | { text: string }
  | { functionCall: { id?: string; name: string; args: unknown } }
  | { functionResponse: { id?: string; name: string; response: Record<string, unknown> } };

interface Content {
  role: "user" | "model";
  parts: Part[];
}

interface GeminiResponse {
  modelVersion?: string;
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
        functionCall?: { id?: string; name?: string; args?: unknown };
      }>;
    };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

function toolResponse(content: string, isError?: boolean): Record<string, unknown> {
  let value: unknown = content;
  try {
    value = JSON.parse(content);
  } catch {
    // keep as string
  }
  const wrapped =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { result: value };
  return isError ? { error: wrapped } : wrapped;
}

/** Converts normalized messages to Gemini `systemInstruction` + `contents`. Exported for testing. */
export function toGeminiContents(messages: Message[]): {
  systemInstruction?: { parts: { text: string }[] };
  contents: Content[];
} {
  const system: string[] = [];
  const contents: Content[] = [];
  const push = (role: Content["role"], parts: Part[]) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const m of messages) {
    switch (m.role) {
      case "system":
        system.push(m.content);
        break;
      case "user":
        push("user", [{ text: m.content }]);
        break;
      case "assistant": {
        const parts: Part[] = m.content ? [{ text: m.content }] : [];
        for (const c of m.toolCalls ?? []) {
          parts.push({ functionCall: { id: c.id, name: c.name, args: c.input ?? {} } });
        }
        push("model", parts.length ? parts : [{ text: "" }]);
        break;
      }
      case "tool":
        push("user", [
          {
            functionResponse: {
              id: m.toolCallId,
              name: m.toolName,
              response: toolResponse(m.content, m.isError),
            },
          },
        ]);
        break;
    }
  }
  return {
    systemInstruction: system.length ? { parts: [{ text: system.join("\n\n") }] } : undefined,
    contents,
  };
}

function finishReason(reason: string | undefined, hasCalls: boolean): FinishReason {
  if (hasCalls) return "tool_calls";
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "content_filter";
    default:
      return "other";
  }
}

/** Builds the `generateContent` request body. Exported for testing. */
export function buildGeminiBody(request: GenerateRequest) {
  const { systemInstruction, contents } = toGeminiContents(request.messages);
  const generationConfig: Record<string, unknown> = {};
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
  if (request.maxTokens !== undefined) generationConfig.maxOutputTokens = request.maxTokens;
  if (request.stopSequences?.length) generationConfig.stopSequences = request.stopSequences;
  if (request.responseFormat) {
    generationConfig.responseMimeType = "application/json";
    if (request.responseFormat.schema)
      generationConfig.responseJsonSchema = request.responseFormat.schema;
  }
  const body: Record<string, unknown> = { contents };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  if (request.tools?.length) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          parametersJsonSchema: t.inputSchema,
        })),
      },
    ];
    const c = request.toolChoice;
    if (c) {
      body.toolConfig = {
        functionCallingConfig:
          c === "auto"
            ? { mode: "AUTO" }
            : c === "none"
              ? { mode: "NONE" }
              : c === "required"
                ? { mode: "ANY" }
                : { mode: "ANY", allowedFunctionNames: [c.name] },
      };
    }
  }
  return { ...body, ...request.providerOptions };
}

/**
 * Creates a Gemini provider.
 *
 * @example
 * ```ts
 * const ai = createWeave({ provider: gemini({ model: "gemini-2.5-flash" }) });
 * ```
 */
export function gemini(options: GeminiOptions = {}): Provider {
  const model = options.model ?? "gemini-2.5-flash";
  const baseURL = (options.baseURL ?? "https://generativelanguage.googleapis.com/v1beta").replace(
    /\/+$/,
    "",
  );
  return {
    id: "gemini",
    model,
    capabilities: {
      tools: true,
      structuredOutput: true,
      vision: true,
      streaming: false,
      maxContextTokens: 1_000_000,
    },
    async generate(request: GenerateRequest, call?: CallOptions): Promise<GenerateResponse> {
      const apiKey = resolveApiKey("gemini", options.apiKey, ["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
      const json = await postJson<GeminiResponse>({
        provider: "gemini",
        url: `${baseURL}/models/${encodeURIComponent(model)}:generateContent`,
        headers: { "x-goog-api-key": apiKey, ...options.headers },
        body: buildGeminiBody(request),
        fetch: options.fetch,
        signal: call?.signal,
      });
      if (json.promptFeedback?.blockReason) {
        throw new ContentFilterError(
          `gemini blocked the prompt: ${json.promptFeedback.blockReason}`,
          {
            provider: "gemini",
          },
        );
      }
      const candidate = json.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      const text = parts
        .filter((p) => typeof p.text === "string" && !p.thought)
        .map((p) => p.text)
        .join("");
      const toolCalls = parts
        .filter((p) => p.functionCall)
        .map((p) => ({
          id: p.functionCall?.id ?? randomId("call"),
          name: p.functionCall?.name ?? "",
          input: p.functionCall?.args ?? {},
        }));
      const usage = json.usageMetadata;
      return {
        text,
        toolCalls,
        finishReason: finishReason(candidate?.finishReason, toolCalls.length > 0),
        usage: {
          inputTokens: usage?.promptTokenCount ?? 0,
          // Thinking tokens are billed as output.
          outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
        },
        model: json.modelVersion,
        raw: json,
      };
    },
  };
}
