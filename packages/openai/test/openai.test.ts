import { describe, expect, it } from "vitest";
import { buildOpenAIBody, openai, toOpenAIMessages } from "@ai-weave/openai";
import { json, runProviderContract, scriptedFetch } from "../../../tests/provider-contract.js";

const completion = (
  message: Record<string, unknown>,
  finish_reason: string,
  usage = { input: 1, output: 1 },
) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "gpt-4o-mini-2024-07-18",
  choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason }],
  usage: {
    prompt_tokens: usage.input,
    completion_tokens: usage.output,
    total_tokens: usage.input + usage.output,
  },
});

runProviderContract({
  name: "openai",
  envVars: ["OPENAI_API_KEY"],
  create: (fetch, o) => openai({ fetch, apiKey: o?.apiKey, model: "gpt-4o-mini" }),
  text: (text, u) => completion({ content: text }, "stop", u),
  toolCall: (id, name, input) =>
    completion(
      {
        content: null,
        tool_calls: [
          { id, type: "function", function: { name, arguments: JSON.stringify(input) } },
        ],
      },
      "tool_calls",
    ),
  structured: (value) => completion({ content: JSON.stringify(value) }, "stop"),
  errorBody: (message) => ({ error: { message, type: "invalid_request_error", code: null } }),
});

describe("openai adapter", () => {
  it("converts messages including tool calls and results", () => {
    expect(
      toOpenAIMessages([
        { role: "system", content: "s" },
        { role: "user", content: "u" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "f", input: { a: 1 } }] },
        { role: "tool", toolCallId: "c1", toolName: "f", content: '{"ok":true}' },
        { role: "assistant", content: "" },
        {
          role: "assistant",
          content: "done",
          toolCalls: [{ id: "c2", name: "g", input: undefined }],
        },
      ]),
    ).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
      { role: "assistant", content: "" },
      {
        role: "assistant",
        content: "done",
        tool_calls: [{ id: "c2", type: "function", function: { name: "g", arguments: "{}" } }],
      },
    ]);
  });

  it("builds bodies for tools, json_schema and json_object", () => {
    const base = { messages: [{ role: "user" as const, content: "x" }] };
    const tools = [{ name: "t", description: "d", inputSchema: { type: "object" } }];
    expect(
      buildOpenAIBody("m", {
        ...base,
        maxTokens: 10,
        temperature: 0,
        stopSequences: ["X"],
        tools,
        toolChoice: "required",
      }),
    ).toMatchObject({
      max_completion_tokens: 10,
      temperature: 0,
      stop: ["X"],
      tools: [
        {
          type: "function",
          function: { name: "t", description: "d", parameters: { type: "object" } },
        },
      ],
      tool_choice: "required",
    });
    expect(buildOpenAIBody("m", { ...base, maxTokens: 10 }, "max_tokens").max_tokens).toBe(10);
    expect(buildOpenAIBody("m", { ...base, tools, toolChoice: { name: "t" } }).tool_choice).toEqual(
      { type: "function", function: { name: "t" } },
    );
    expect(
      buildOpenAIBody("m", {
        ...base,
        responseFormat: {
          type: "json",
          name: "my schema!",
          description: "d",
          schema: { type: "object" },
        },
      }).response_format,
    ).toEqual({
      type: "json_schema",
      json_schema: {
        name: "my_schema_",
        description: "d",
        strict: false,
        schema: { type: "object" },
      },
    });
    expect(
      buildOpenAIBody("m", { ...base, responseFormat: { type: "json" } }).response_format,
    ).toEqual({ type: "json_object" });
  });

  it("supports OpenAI-compatible servers without a key", async () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "real-openai-key";
    try {
      const { fetch, requests } = scriptedFetch([json(completion({ content: "hi" }, "length"))]);
      const p = openai({
        fetch,
        id: "ollama",
        baseURL: "http://localhost:11434/v1/",
        model: "llama3.1",
        capabilities: { structuredOutput: false },
      });
      expect(p.id).toBe("ollama");
      expect(p.capabilities.structuredOutput).toBe(false);
      const res = await p.generate({ messages: [{ role: "user", content: "x" }] });
      expect(requests[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
      // The OpenAI key from the environment must not leak to third-party base URLs.
      expect(requests[0]!.headers.authorization).toBeUndefined();
      expect(res.finishReason).toBe("length");
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });

  it("sends bearer + organization headers and maps refusals and odd payloads", async () => {
    const { fetch, requests } = scriptedFetch([
      json(completion({ content: null, refusal: "I can't" }, "stop")),
      json({
        choices: [
          {
            message: { tool_calls: [{ id: "c", function: { arguments: "not json" } }] },
            finish_reason: "function_call",
          },
        ],
      }),
      json({ choices: [{ finish_reason: "content_filter" }] }),
      json({}),
    ]);
    const p = openai({ fetch, apiKey: "sk", organization: "org_1" });
    const refusal = await p.generate({ messages: [{ role: "user", content: "x" }] });
    expect(requests[0]!.headers).toMatchObject({
      authorization: "Bearer sk",
      "openai-organization": "org_1",
    });
    expect(refusal.finishReason).toBe("content_filter");
    const odd = await p.generate({ messages: [{ role: "user", content: "x" }] });
    expect(odd.toolCalls[0]).toEqual({ id: "c", name: "", input: "not json" });
    expect(odd.finishReason).toBe("tool_calls");
    expect((await p.generate({ messages: [{ role: "user", content: "x" }] })).finishReason).toBe(
      "content_filter",
    );
    const empty = await p.generate({ messages: [{ role: "user", content: "x" }] });
    expect(empty).toMatchObject({
      text: "",
      finishReason: "other",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });
});
