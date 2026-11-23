import { describe, expect, it } from "vitest";
import { anthropic, buildAnthropicBody, toAnthropicMessages } from "@ai-weave/anthropic";
import { json, runProviderContract, scriptedFetch } from "../../../tests/provider-contract.js";

runProviderContract({
  name: "anthropic",
  envVars: ["ANTHROPIC_API_KEY"],
  create: (fetch, o) => anthropic({ fetch, apiKey: o?.apiKey, model: "claude-sonnet-4-5" }),
  text: (text, u) => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5-20250929",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: u.input, output_tokens: u.output },
  }),
  toolCall: (id, name, input) => ({
    content: [
      { type: "text", text: "Saving." },
      { type: "tool_use", id, name, input },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1 },
  }),
  structured: (value, name) => ({
    content: [{ type: "tool_use", id: "toolu_1", name, input: value }],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1 },
  }),
  errorBody: (message) => ({ type: "error", error: { type: "api_error", message } }),
});

describe("anthropic adapter", () => {
  it("converts messages: system, merged tool results, tool_use blocks", () => {
    const { system, messages } = toAnthropicMessages([
      { role: "system", content: "a" },
      { role: "system", content: "b" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "t1", name: "x", input: { q: 1 } },
          { id: "t2", name: "y", input: undefined },
        ],
      },
      { role: "tool", toolCallId: "t1", toolName: "x", content: "r1" },
      { role: "tool", toolCallId: "t2", toolName: "y", content: "r2", isError: true },
      { role: "assistant", content: "" },
    ]);
    expect(system).toBe("a\n\nb");
    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "x", input: { q: 1 } },
          { type: "tool_use", id: "t2", name: "y", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "r1" },
          { type: "tool_result", tool_use_id: "t2", content: "r2", is_error: true },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "" }] },
    ]);
  });

  it("builds request bodies with tools, tool choice and forced structured output", () => {
    const base = { messages: [{ role: "user" as const, content: "x" }] };
    const tools = [{ name: "t", description: "d", inputSchema: { type: "object" } }];
    expect(buildAnthropicBody("m", base, 100)).toEqual({
      model: "m",
      max_tokens: 100,
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    });
    expect(
      buildAnthropicBody(
        "m",
        {
          ...base,
          tools,
          toolChoice: "required",
          temperature: 0,
          stopSequences: ["END"],
          maxTokens: 5,
        },
        100,
      ),
    ).toMatchObject({
      max_tokens: 5,
      temperature: 0,
      stop_sequences: ["END"],
      tools: [{ name: "t", description: "d", input_schema: { type: "object" } }],
      tool_choice: { type: "any" },
    });
    expect(buildAnthropicBody("m", { ...base, tools, toolChoice: "auto" }, 1).tool_choice).toEqual({
      type: "auto",
    });
    expect(buildAnthropicBody("m", { ...base, tools, toolChoice: "none" }, 1).tool_choice).toEqual({
      type: "none",
    });
    expect(
      buildAnthropicBody("m", { ...base, tools, toolChoice: { name: "t" } }, 1).tool_choice,
    ).toEqual({ type: "tool", name: "t" });
    const structured = buildAnthropicBody(
      "m",
      { ...base, responseFormat: { type: "json", schema: { type: "object", properties: {} } } },
      1,
    );
    expect(structured.tool_choice).toEqual({ type: "tool", name: "result" });
    expect(structured.tools).toEqual([
      {
        name: "result",
        description: "Return the result as structured data.",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });

  it("sends auth headers to the configured base URL", async () => {
    const { fetch, requests } = scriptedFetch([json({ content: [], stop_reason: "max_tokens" })]);
    const res = await anthropic({
      fetch,
      apiKey: "sk-test",
      baseURL: "https://proxy.example/",
      headers: { "anthropic-beta": "x" },
    }).generate({
      messages: [{ role: "user", content: "x" }],
    });
    expect(requests[0]!.url).toBe("https://proxy.example/v1/messages");
    expect(requests[0]!.headers).toMatchObject({
      "x-api-key": "sk-test",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "x",
    });
    expect(res.finishReason).toBe("length");
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("maps refusals to content_filter", async () => {
    const { fetch } = scriptedFetch([
      json({ content: [{ type: "text", text: "no" }], stop_reason: "refusal" }),
      json({ content: [], stop_reason: "pause_turn" }),
    ]);
    const p = anthropic({ fetch, apiKey: "k" });
    expect((await p.generate({ messages: [{ role: "user", content: "x" }] })).finishReason).toBe(
      "content_filter",
    );
    expect((await p.generate({ messages: [{ role: "user", content: "x" }] })).finishReason).toBe(
      "other",
    );
  });
});
