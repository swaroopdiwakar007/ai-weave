import type { z } from "zod";
import {
  buildMessages,
  optionsFor,
  TaskRun,
  type BaseTaskOptions,
  type WeaveContext,
} from "../engine.js";
import { ContentFilterError, ValidationError } from "../errors.js";
import { formatIssues, prepareSchema, type Schema } from "../schema.js";
import type { Message, Provider, Usage } from "../types.js";
import { parseJsonLoose } from "../utils.js";

/** Options for `ai.generateObject()`. */
export interface GenerateObjectOptions<S extends Schema> extends BaseTaskOptions {
  /** Zod schema of the expected output. */
  schema: S;
  prompt?: string;
  messages?: Message[];
  system?: string;
  /** Name for the schema, sent to providers that support it. Default `"result"`. */
  schemaName?: string;
  schemaDescription?: string;
  /** How many times to ask the model to fix invalid output. Default 2. */
  maxRepairs?: number;
  temperature?: number;
  maxTokens?: number;
}

/** Result of `ai.generateObject()`. */
export interface GenerateObjectResult<T> {
  data: T;
  usage: Usage;
  /** Number of repair round-trips that were needed. */
  repairs: number;
}

const JSON_ONLY = "Respond with a single JSON value only: no prose, no markdown code fences.";

function schemaInstructions(jsonSchema: unknown): string {
  return `${JSON_ONLY}\nThe JSON must conform to this JSON Schema:\n${JSON.stringify(jsonSchema)}`;
}

function repairPrompt(issues: string[]): string {
  return [
    "Your previous response did not match the required schema.",
    "Problems:",
    ...issues.map((i) => `- ${i}`),
    `Return the corrected JSON. ${JSON_ONLY}`,
  ].join("\n");
}

/** Validates a parsed candidate. Exposed for the extraction fast path. */
export function validate<S extends Schema>(
  schema: S,
  value: unknown,
): { success: true; data: z.output<S> } | { success: false; issues: string[] } {
  const result = schema.safeParse(value);
  return result.success
    ? { success: true, data: result.data as z.output<S> }
    : { success: false, issues: formatIssues(result.error) };
}

/**
 * Core structured-output loop. Uses the provider's native structured output when available,
 * otherwise JSON-in-prompt. Invalid output triggers a repair prompt up to `maxRepairs` times.
 */
export async function runObjectWith<S extends Schema>(
  run: TaskRun,
  options: GenerateObjectOptions<S>,
): Promise<{ data: z.output<S>; repairs: number }> {
  const { jsonSchema, wrapped } = prepareSchema(options.schema);
  const maxRepairs = options.maxRepairs ?? 2;
  let conversation = buildMessages(options);

  const build = (provider: Provider) => {
    const native = provider.capabilities.structuredOutput;
    return {
      messages: native
        ? conversation
        : [{ role: "system" as const, content: schemaInstructions(jsonSchema) }, ...conversation],
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      responseFormat: native
        ? {
            type: "json" as const,
            schema: jsonSchema,
            name: options.schemaName ?? "result",
            description: options.schemaDescription,
          }
        : undefined,
      providerOptions: optionsFor(options.providerOptions, provider),
    };
  };

  let issues: string[] = [];
  let raw = "";
  for (let repairs = 0; repairs <= maxRepairs; repairs++) {
    const { response } = await run.call(build);
    raw = response.text;
    if (response.finishReason === "content_filter") {
      throw new ContentFilterError("The provider blocked the response", {
        provider: run.usage().provider,
      });
    }
    let parsed: unknown;
    try {
      parsed = parseJsonLoose(raw);
    } catch {
      issues = ["Response is not valid JSON"];
    }
    if (parsed !== undefined) {
      const candidate =
        wrapped && parsed && typeof parsed === "object" && "value" in parsed
          ? (parsed as { value: unknown }).value
          : parsed;
      const result = validate(options.schema, candidate);
      if (result.success) return { data: result.data, repairs };
      issues = result.issues;
    }
    if (response.finishReason === "length") {
      issues.push("Output was cut off at the token limit; increase `maxTokens`");
      break;
    }
    conversation = [
      ...conversation,
      { role: "assistant", content: raw },
      { role: "user", content: repairPrompt(issues) },
    ];
  }
  throw new ValidationError(`Model output failed schema validation: ${issues.join("; ")}`, {
    issues,
    rawOutput: raw,
    provider: run.usage().provider,
  });
}

export async function runGenerateObject<S extends Schema>(
  ctx: WeaveContext,
  options: GenerateObjectOptions<S>,
  task = "generateObject",
): Promise<GenerateObjectResult<z.output<S>>> {
  const run = new TaskRun(ctx, task, options.signal);
  const { data, repairs } = await runObjectWith(run, options);
  return { data, repairs, usage: run.finish() };
}
