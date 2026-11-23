/**
 * Test utilities. Import from `@ai-weave/core/testing`.
 * @module
 */
import { WeaveError } from "../errors.js";
import type {
  CallOptions,
  GenerateRequest,
  GenerateResponse,
  Provider,
  ProviderCapabilities,
} from "../types.js";
import { sleep } from "../utils.js";

/** A scripted reply: text, a partial response, `{ json }`, an error to throw, or a function. */
export type MockReply =
  | string
  | (Partial<GenerateResponse> & { json?: unknown })
  | Error
  | ((request: GenerateRequest, callIndex: number) => MockReply | Promise<MockReply>);

export interface MockProviderOptions {
  id?: string;
  model?: string;
  capabilities?: Partial<ProviderCapabilities>;
  /** Replies returned in order, one per call. */
  responses?: MockReply[];
  /** Reply used once `responses` is exhausted. Without it, extra calls throw. */
  defaultResponse?: MockReply;
  /** Simulated latency (respects abort signals). */
  delayMs?: number;
}

/** A deterministic {@link Provider} for unit tests. */
export interface MockProvider extends Provider {
  /** Every request received, in order. */
  readonly calls: GenerateRequest[];
  /** Queues more replies. */
  enqueue(...replies: MockReply[]): void;
}

async function resolveReply(
  reply: MockReply,
  request: GenerateRequest,
  index: number,
): Promise<GenerateResponse> {
  if (typeof reply === "function") return resolveReply(await reply(request, index), request, index);
  if (reply instanceof Error) throw reply;
  if (typeof reply === "string") reply = { text: reply };
  const { json, ...rest } = reply;
  return {
    text: json !== undefined ? JSON.stringify(json) : "",
    toolCalls: [],
    finishReason: rest.toolCalls?.length ? "tool_calls" : "stop",
    usage: { inputTokens: 10, outputTokens: 5 },
    ...rest,
  };
}

/**
 * Creates a mock provider with scripted replies.
 *
 * @example
 * ```ts
 * const provider = mockProvider({ responses: [{ json: { title: "Soup" } }] });
 * const ai = createWeave({ provider });
 * ```
 */
export function mockProvider(options: MockProviderOptions = {}): MockProvider {
  const queue = [...(options.responses ?? [])];
  const calls: GenerateRequest[] = [];
  return {
    id: options.id ?? "mock",
    model: options.model ?? "mock-model",
    capabilities: {
      tools: true,
      structuredOutput: true,
      vision: false,
      streaming: false,
      ...options.capabilities,
    },
    calls,
    enqueue: (...replies) => queue.push(...replies),
    async generate(request: GenerateRequest, callOptions?: CallOptions) {
      const index = calls.length;
      calls.push(request);
      if (options.delayMs) await sleep(options.delayMs, callOptions?.signal);
      const reply = queue.length ? queue.shift()! : options.defaultResponse;
      if (reply === undefined) {
        throw new WeaveError(`mockProvider: no reply scripted for call #${index + 1}`);
      }
      return resolveReply(reply, request, index);
    },
  };
}
