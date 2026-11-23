import { z } from "zod";
import { ConfigError } from "./errors.js";
import type { JsonSchema } from "./types.js";

/** Any Zod schema. */
export type Schema = z.ZodType;

/** Converts a JSON-Schema-ish value, removing keys that some providers reject. */
function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$schema" || key === "~standard") continue;
      out[key] = clean(value);
    }
    return out;
  }
  return node;
}

/** Converts a Zod schema to a draft-07 JSON Schema suitable for LLM providers. */
export function toJsonSchema(schema: Schema): JsonSchema {
  try {
    const json = z.toJSONSchema(schema, { target: "draft-7", io: "input", unrepresentable: "any" });
    return clean(json) as JsonSchema;
  } catch (error) {
    throw new ConfigError("Could not convert schema to JSON Schema", { cause: error });
  }
}

/** Result of {@link prepareSchema}. */
export interface PreparedSchema {
  /** JSON Schema with an object root (providers require one). */
  jsonSchema: JsonSchema;
  /** True if the original schema was wrapped as `{ value: <schema> }`. */
  wrapped: boolean;
}

/** Prepares a schema for providers, wrapping non-object roots in `{ value }`. */
export function prepareSchema(schema: Schema): PreparedSchema {
  const json = toJsonSchema(schema);
  if (json.type === "object") return { jsonSchema: json, wrapped: false };
  const { definitions, $defs, ...inner } = json as JsonSchema & {
    definitions?: unknown;
    $defs?: unknown;
  };
  const wrapper: JsonSchema = {
    type: "object",
    properties: { value: inner },
    required: ["value"],
    additionalProperties: false,
  };
  if (definitions) wrapper.definitions = definitions;
  if ($defs) wrapper.$defs = $defs;
  return { jsonSchema: wrapper, wrapped: true };
}

/** Formats Zod issues as short `path: message` strings. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.map(String).join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}
