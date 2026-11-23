# Build Prompt: ai-weave

Copy everything below the line into a coding agent (Claude Code, Cursor, etc.). Build one phase at a time. Start with "Phase 0 + Phase 1", then send the next phase.

---

You are a senior TypeScript library engineer. Build **ai-weave**, an open-source, provider-agnostic library that lets app developers add AI features to their apps with minimal code. The library should support:

1. **Structured extraction**: turn a URL or raw text into a typed, validated object (e.g. a recipe app: user pastes a recipe website link → the app stores a `Recipe` object).
2. **Chat**: an embeddable assistant with persistent sessions, streaming, and tools that call the app's own functions.
3. **AI search**: semantic/hybrid search over the app's own data, with optional grounded answers and citations.

It must work with **Anthropic Claude, OpenAI, and Google Gemini** through one interface. Switching providers should take one line of code, and an optional fallback chain should be supported.

## Tech constraints

- pnpm workspaces + Turborepo monorepo. TypeScript `strict`. Builds with tsup (ESM + CJS + .d.ts). Tests with Vitest. ESLint + Prettier. Changesets for versioning. GitHub Actions CI.
- Node 18+ and edge runtimes (use Web `fetch`/`Request`/`Response`/`ReadableStream`; no Node-only APIs in `core`).
- Zod for schemas. Provider SDKs are **optional peer dependencies** of their adapter packages only.
- Keep it tree-shakeable. Minimize dependencies. Every public API gets TSDoc comments.

## Packages

- `@ai-weave/core`: `createWeave`, tasks (`generate`, `extract`, `classify`, `summarize`, `chat`, `search`), structured-output engine, tool loop, streaming, retries/timeouts/fallback, cache, usage/cost tracking, typed errors, interfaces (`Provider`, `Fetcher`, `Store`, `VectorStore`, `Embedder`, `Cache`), in-memory adapters, `mockProvider` test utility.
- `@ai-weave/anthropic`, `@ai-weave/openai`, `@ai-weave/gemini`: provider adapters (chat, streaming, tools, native structured output where available, embeddings where available).
- `@ai-weave/web`: URL fetcher with SSRF protection (block private/loopback/link-local IPs, including after redirects; http/https only; size, time, and redirect limits), HTML → clean markdown (Readability-style), schema.org JSON-LD/microdata detection. Optional Playwright fetcher behind a separate entry point.
- `@ai-weave/search`: chunking, embedding, memory + pgvector vector stores, hybrid retrieval, metadata filters, grounded answers with citations.
- `@ai-weave/server`: `createHandler(ai, { auth, rateLimit, schemas })` built on Web `Request`/`Response`. Routes: `/chat` (SSE), `/extract`, `/search`, `/generate`. Clients reference **registered schemas by name** and never send raw system prompts. Include adapters/examples for Next.js App Router and Express.
- `@ai-weave/react`: `useChat`, `useExtract`, `useSearch`, and a `ChatWidget` (headless + default styled).
- `examples/recipe-app`: Next.js app. Paste URL → extract recipe → save → chat with an assistant that can save/search recipes → AI search over saved recipes.

## Target developer experience (must compile and work)

```ts
const ai = createWeave({
  provider: anthropic({ model: "claude-sonnet-4-5" }),
  fallback: [openai({ model: "gpt-4o-mini" })],
  cache: true,
  onUsage: (u) => log(u),
});

const { data, source, usage } = await ai.extract({ url, schema: Recipe }); // data: z.infer<typeof Recipe>

const chat = ai.chat({ system, tools: { saveRecipe: tool({ input: Recipe, run: save }) }, store });
for await (const ev of chat.send(sessionId, "Save the recipe at <url>")) {
  /* text | tool_call | tool_result | usage | done */
}

const idx = ai.search.index("recipes", { embedder, vectorStore });
await idx.upsert(docs);
const { results, answer } = await idx.query("quick vegetarian dinner", {
  answer: true,
  filter: { cuisine: "italian" },
});
```

## Behavioral requirements

- **Provider layer:** normalized message, tool-call, streaming, and usage types. Provider errors are mapped to `RateLimitError | AuthError | ContextLengthError | ContentFilterError | ProviderError | ValidationError`. Retries use exponential backoff with jitter and apply only to retryable errors. The fallback chain moves to the next provider on retryable/provider errors. `AbortSignal` is supported everywhere. `providerOptions` passes vendor-specific options through.
- **Structured output:** Zod → JSON Schema. Prefer native structured output/tool calling, then fall back to JSON-in-prompt. Validate with Zod. On failure, send a repair prompt containing the validation errors (configurable `maxRepairs`, default 2). Support `streamObject` for partial objects.
- **URL extraction pipeline:** guard → fetch → if JSON-LD matches the schema's domain (e.g. `@type: Recipe`), map it and only use the LLM to normalize or fill gaps → otherwise clean to markdown, truncate or chunk to fit context → LLM extraction. Wrap scraped content in clear delimiters as **untrusted data** and instruct the model to ignore any instructions inside it. Return `source.method: "jsonld" | "llm" | "hybrid"`.
- **Chat:** session persistence via `Store` (memory + SQLite implementations). Tool loop with `maxSteps`, per-tool timeout, and optional `requireApproval`. Sliding-window context with optional summarization of old turns.
- **Search:** token-based and markdown-section chunkers, batch embeddings, cosine similarity in the memory store, pgvector adapter, keyword fallback, and answers that cite result IDs and say "not found" when results are insufficient.
- **Observability:** every result includes `usage { provider, model, inputTokens, outputTokens, costUsd, latencyMs, cached }`. `onRequest/onResponse/onError/onUsage` hooks. Per-model price table that can be overridden.
- **Security:** no API keys ever reach client packages. Per-user rate limiting and spend limits in the server handler. Optional PII redaction hook before provider calls.

## Testing

- Unit tests for every module using `mockProvider` (scripted responses, tool calls, streaming, errors).
- A shared **provider contract test suite** that runs against each adapter using recorded fixtures.
- Fetcher/extract tests use saved HTML fixtures (including a page with JSON-LD, one without, and one containing a prompt-injection attempt). No live network in CI.
- Opt-in live tests behind `LIVE=1` using real API keys from env.
- Target ≥85% coverage in `core`, `web`, and `search`.

## Documentation

- Root README with quickstart (≤10 lines to first extraction), a provider-switching example, and a security notes section.
- Per-package README with API reference, plus a "Recipes" doc covering: recipe extractor, support chatbot, product search, and swapping providers.

## Delivery: work in phases, and stop after each one for review

- **Phase 0:** monorepo scaffolding, tooling, CI, empty packages that build.
- **Phase 1:** core + 3 providers + `generate`/`extract` (text + URL, JSON-LD fast path) + retries/fallback/usage + `mockProvider` + minimal recipe example (CLI or simple page).
- **Phase 2:** chat + tools + streaming + stores + server handler + React hooks/ChatWidget, integrated into the recipe app.
- **Phase 3:** search package + AI search in the recipe app.
- **Phase 4:** cache, Playwright fetcher, OTel hooks, rate/spend limits, docs polish, v1.0 changeset.

For each phase: first post a brief design note (files, key types, any deviations from this spec with reasons), then implement, then run `pnpm build && pnpm lint && pnpm test`. Fix all failures before finishing. End with a summary of what was built and what's next. Ask before adding any dependency over 100 KB or making a breaking change to the public API above.
