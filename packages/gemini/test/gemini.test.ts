import { describe, expect, it } from "vitest";
import { ContentFilterError } from "@ai-weave/core";
import { buildGeminiBody, gemini, toGeminiContents } from "@ai-weave/gemini";
import { json, runProviderContract, scriptedFetch } from "../../../tests/provider-contract.js";

const response = (parts: unknown[], finishReason = "STOP", usage = { input: 1, output: 1 }) => ({
  candidates: [{ content: { role: "model", parts }, finishReason }],
  usageMetadata: { promptTokenCount: usage.input, candidatesTokenCount: usage.output },
  modelVersion: "gemini-2.5-flash",
});

runProviderContract({
  name: "gemini",
  envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  create: (fetch, o) => gemini({ fetch, apiKey: o?.apiKey }),
  text: (text, u) => response([{ text }], "STOP", u),
  toolCall: (id, name, input) => response([{ functionCall: { id, name, args: input } }]),
  structured: (value) => response([{ text: JSON.stringify(value) }]),
  errorBody: (message) => ({ error: { code: 400, message, status: "INVALID_ARGUMENT" } }),
});

describe("gemini adapter", () => {
  it("converts messages to systemInstruction and contents", () => {
    const { systemInstruction, contents } = toGeminiContents([
      { role: "system", content: "s1" },
      { role: "system", content: "s2" },
      { role: "user", content: "u" },
      {
        role: "assistant",
        content: "thinking",
        toolCalls: [{ id: "c1", name: "f", input: { a: 1 } }],
      },
      { role: "tool", toolCallId: "c1", toolName: "f", content: '{"ok":true}' },
      { role: "tool", toolCallId: "c2", toolName: "g", content: "plain text", isError: true },
      { role: "tool", toolCallId: "c3", toolName: "h", content: "[1,2]" },
      { role: "assistant", content: "" },
    ]);
    expect(systemInstruction).toEqual({ parts: [{ text: "s1\n\ns2" }] });
    expect(contents).toEqual([
      { role: "user", parts: [{ text: "u" }] },
      {
        role: "model",
        parts: [{ text: "thinking" }, { functionCall: { id: "c1", name: "f", args: { a: 1 } } }],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { id: "c1", name: "f", response: { ok: true } } },
          {
            functionResponse: {
              id: "c2",
              name: "g",
              response: { error: { result: "plain text" } },
            },
          },
          { functionResponse: { id: "c3", name: "h", response: { result: [1, 2] } } },
        ],
      },
      { role: "model", parts: [{ text: "" }] },
    ]);
  });

  it("builds generationConfig, tools and toolConfig", () => {
    const base = { messages: [{ role: "user" as const, content: "x" }] };
    const tools = [{ name: "t", description: "d", inputSchema: { type: "object" } }];
    expect(buildGeminiBody(base)).toEqual({ contents: [{ role: "user", parts: [{ text: "x" }] }] });
    const body = buildGeminiBody({
      ...base,
      temperature: 0,
      maxTokens: 50,
      stopSequences: ["END"],
      responseFormat: { type: "json", schema: { type: "object" } },
      tools,
      toolChoice: { name: "t" },
    });
    expect(body.generationConfig).toEqual({
      temperature: 0,
      maxOutputTokens: 50,
      stopSequences: ["END"],
      responseMimeType: "application/json",
      responseJsonSchema: { type: "object" },
    });
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          { name: "t", description: "d", parametersJsonSchema: { type: "object" } },
        ],
      },
    ]);
    expect(body.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["t"] },
    });
    expect(buildGeminiBody({ ...base, tools, toolChoice: "auto" }).toolConfig).toEqual({
      functionCallingConfig: { mode: "AUTO" },
    });
    expect(buildGeminiBody({ ...base, tools, toolChoice: "none" }).toolConfig).toEqual({
      functionCallingConfig: { mode: "NONE" },
    });
    expect(buildGeminiBody({ ...base, tools, toolChoice: "required" }).toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY" },
    });
    expect(buildGeminiBody({ ...base, responseFormat: { type: "json" } }).generationConfig).toEqual(
      { responseMimeType: "application/json" },
    );
  });

  it("calls the model endpoint with the API key header", async () => {
    const { fetch, requests } = scriptedFetch([json(response([{ text: "ok" }], "MAX_TOKENS"))]);
    const res = await gemini({ fetch, apiKey: "g-key", model: "gemini-2.5-pro" }).generate({
      messages: [{ role: "user", content: "x" }],
    });
    expect(requests[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    );
    expect(requests[0]!.headers["x-goog-api-key"]).toBe("g-key");
    expect(res.finishReason).toBe("length");
  });

  it("skips thought parts, counts thinking tokens and generates missing call ids", async () => {
    const { fetch } = scriptedFetch([
      json({
        candidates: [
          {
            content: {
              parts: [
                { text: "hmm", thought: true },
                { text: "answer" },
                { functionCall: { name: "f" } },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 10 },
      }),
    ]);
    const res = await gemini({ fetch, apiKey: "k" }).generate({
      messages: [{ role: "user", content: "x" }],
    });
    expect(res.text).toBe("answer");
    expect(res.toolCalls[0]).toMatchObject({ name: "f", input: {} });
    expect(res.toolCalls[0]!.id).toMatch(/^call_/);
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 12 });
  });

  it("maps safety blocks", async () => {
    const { fetch } = scriptedFetch([
      json({ promptFeedback: { blockReason: "SAFETY" } }),
      json(response([], "SAFETY")),
      json({ candidates: [{ finishReason: "OTHER" }] }),
    ]);
    const p = gemini({ fetch, apiKey: "k" });
    await expect(p.generate({ messages: [{ role: "user", content: "x" }] })).rejects.toBeInstanceOf(
      ContentFilterError,
    );
    expect((await p.generate({ messages: [{ role: "user", content: "x" }] })).finishReason).toBe(
      "content_filter",
    );
    expect((await p.generate({ messages: [{ role: "user", content: "x" }] })).finishReason).toBe(
      "other",
    );
  });

  it("falls back to GOOGLE_API_KEY", async () => {
    const saved = { g: process.env.GEMINI_API_KEY, o: process.env.GOOGLE_API_KEY };
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_API_KEY = "google-key";
    try {
      const { fetch, requests } = scriptedFetch([json(response([{ text: "ok" }]))]);
      await gemini({ fetch }).generate({ messages: [{ role: "user", content: "x" }] });
      expect(requests[0]!.headers["x-goog-api-key"]).toBe("google-key");
    } finally {
      if (saved.g !== undefined) process.env.GEMINI_API_KEY = saved.g;
      if (saved.o === undefined) delete process.env.GOOGLE_API_KEY;
      else process.env.GOOGLE_API_KEY = saved.o;
    }
  });
});
