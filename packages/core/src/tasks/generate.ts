import {
  buildMessages,
  optionsFor,
  TaskRun,
  type BaseTaskOptions,
  type WeaveContext,
} from "../engine.js";
import type {
  FinishReason,
  Message,
  ToolCall,
  ToolChoice,
  ToolDefinition,
  Usage,
} from "../types.js";

/** Options for `ai.generate()`. */
export interface GenerateOptions extends BaseTaskOptions {
  /** A user prompt. Appended after `messages`. */
  prompt?: string;
  messages?: Message[];
  system?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  stopSequences?: string[];
}

/** Result of `ai.generate()`. */
export interface GenerateResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: Usage;
}

export async function runGenerate(
  ctx: WeaveContext,
  options: GenerateOptions,
  task = "generate",
): Promise<GenerateResult> {
  const messages = buildMessages(options);
  const run = new TaskRun(ctx, task, options.signal);
  const { response } = await run.call((provider) => ({
    messages,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    tools: options.tools,
    toolChoice: options.toolChoice,
    stopSequences: options.stopSequences,
    providerOptions: optionsFor(options.providerOptions, provider),
  }));
  return {
    text: response.text,
    toolCalls: response.toolCalls,
    finishReason: response.finishReason,
    usage: run.finish(),
  };
}
