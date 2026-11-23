# ai-weave: Plan

> A TypeScript library that lets app developers add AI features (chat, structured extraction from URLs/text, and AI search over app data) with a few lines of code. It works with Claude, OpenAI, and Gemini.

---

## 1. Problem & Positioning

Developers keep building the same AI plumbing over and over:

- They call an LLM provider and then need to switch providers or add a fallback.
- They turn messy input (a URL, a PDF, free text) into **typed, validated data**. Example: recipe app → `Recipe` object.
- They embed a chatbot that knows about the app's data and can take actions.
- They add "AI search" (semantic search plus an answer) over the app's own content.

**Existing tools:** Vercel AI SDK, LangChain.js, LlamaIndex.TS, and Instructor already solve the _low-level_ parts: provider calls, streaming, and tools.
**Where ai-weave fits:** it's a **task-level, batteries-included** layer. Developers call `ai.extract({ url, schema })`, `ai.chat()`, and `ai.search()` directly, without wiring up fetching, cleaning, chunking, prompting, validation, retries, and storage themselves. It stays provider-agnostic and works on the server with minimal config.

## 2. Target Users & Example Use Cases

| App            | Feature                                      | ai-weave API                           |
| -------------- | -------------------------------------------- | -------------------------------------- |
| Recipe app     | Paste a URL → saved structured recipe        | `ai.extract({ url, schema: Recipe })`  |
| Job board      | Paste a job post → normalized fields         | `ai.extract({ text, schema: Job })`    |
| E-commerce     | "Find me waterproof boots under $100"        | `ai.search({ query })` over products   |
| SaaS dashboard | In-app assistant that can call app functions | `ai.chat({ tools })` + `<ChatWidget/>` |
| Notes app      | Summarize / tag / classify content           | `ai.generate()` / `ai.classify()`      |

## 3. Design Principles

1. **Few lines of code for the common case, with escape hatches.** Defaults just work, and every layer can be swapped out.
2. **Provider-agnostic.** One interface. Switch providers by changing one line. Optional fallback chain.
3. **Type-safe structured output.** Zod schemas go in and typed, validated objects come out. If validation fails, the library repairs and retries automatically.
4. **Server-first and secure.** API keys stay on the server. Client packages talk to a provided server handler.
5. **Pluggable adapters.** Storage, vector store, scraper, and cache are interfaces with default in-memory implementations.
6. **Observable and cost-aware.** Every call reports tokens, cost, latency, and provider. Hooks are provided for logging and tracing.
7. **Tree-shakeable and small.** Provider SDKs are optional peer dependencies.

## 4. Architecture

```
┌──────────────────────── App (Next.js / Express / React / RN) ───────────────────────┐
│  @ai-weave/react  (ChatWidget, useChat, useExtract, useSearch)                       │
│            │ HTTP / SSE                                                              │
│  @ai-weave/server (createHandler → Next.js route / Express / Hono / fetch)          │
└────────────┼─────────────────────────────────────────────────────────────────────────┘
             ▼
  @ai-weave/core ── createWeave(config)
     ├─ Tasks:     generate · extract · classify · summarize · chat · search
     ├─ Engine:    prompt builder · structured output (Zod) · tool loop · streaming
     ├─ Reliability: retries · timeouts · fallback chain · rate limits · cache
     ├─ Hooks:     onRequest / onResponse / onError / usage & cost tracking
     └─ Interfaces: Provider · Fetcher · Store · VectorStore · Embedder · Cache
             ▼
  Providers: anthropic · openai · gemini · (ollama / openai-compatible)
  Fetchers:  fetch+readability (default) · playwright (JS sites) · custom
  Stores:    memory · sqlite/postgres · redis
  Vectors:   memory · pgvector · pinecone · qdrant
```

### Packages (monorepo, pnpm + turborepo)

- `@ai-weave/core`: types, `createWeave`, tasks, engine, interfaces, memory adapters
- `@ai-weave/anthropic`, `@ai-weave/openai`, `@ai-weave/gemini`: provider adapters
- `@ai-weave/web`: URL fetching, HTML → clean text/markdown, JSON-LD/microdata detection, SSRF guard
- `@ai-weave/search`: chunking, embeddings, vector store adapters, hybrid search + answer
- `@ai-weave/server`: framework-agnostic request handler (Web `Request`/`Response`), SSE streaming, auth hook
- `@ai-weave/react`: hooks + headless/styled `ChatWidget`
- `examples/`: recipe-app (Next.js), support-chat, product-search

## 5. Core API (target developer experience)

```ts
import { createWeave } from "@ai-weave/core";
import { anthropic } from "@ai-weave/anthropic";
import { openai } from "@ai-weave/openai";
import { z } from "zod";

const ai = createWeave({
  provider: anthropic({ model: "claude-sonnet-4-5" }),   // reads ANTHROPIC_API_KEY
  fallback: [openai({ model: "gpt-4o-mini" })],
  cache: true,
  onUsage: (u) => console.log(u.provider, u.tokens, u.costUsd),
});

// 1. Structured extraction from a URL
const Recipe = z.object({
  title: z.string(),
  servings: z.number().optional(),
  prepTimeMinutes: z.number().optional(),
  ingredients: z.array(z.object({ name: z.string(), quantity: z.string().optional() })),
  steps: z.array(z.string()),
});
const { data, source, usage } = await ai.extract({ url, schema: Recipe });
// data is typed as z.infer<typeof Recipe>

// 2. Chat with tools + persistent sessions
const chat = ai.chat({
  system: "You are the assistant inside RecipeBox.",
  tools: { saveRecipe: tool({ input: Recipe, run: (r) => db.recipes.insert(r) }) },
  store: sqliteStore("./chat.db"),
});
for await (const chunk of chat.send(sessionId, "Save the lasagna from this link: ...")) { ... }

// 3. AI search over app data
const index = ai.search.index("recipes", { embedder: openai.embeddings(), vectorStore: pgvector(pool) });
await index.upsert(recipes.map(r => ({ id: r.id, text: toText(r), metadata: r })));
const { results, answer } = await index.query("quick vegetarian dinner", { answer: true });
```

```ts
// Next.js: app/api/ai/[...route]/route.ts
export const { GET, POST } = createHandler(ai, { auth: (req) => getUser(req) });

// React
<ChatWidget endpoint="/api/ai" sessionId={user.id} />
const { extract, data, status } = useExtract({ endpoint: "/api/ai", schema: "recipe" });
```

## 6. Key Components (detail)

### 6.1 Provider abstraction

- One `Provider` interface: `generate(req)`, `stream(req)`, `capabilities` (tools, json mode, vision, max context), and an optional `embed()`.
- Messages, tool calls, and usage are normalized across vendors. Provider-specific options pass through via `providerOptions`.
- Errors are mapped to a common taxonomy (`RateLimitError`, `AuthError`, `ContextLengthError`, `ContentFilterError`) so retry and fallback logic works the same everywhere.

### 6.2 Structured output engine

- Zod is converted to JSON Schema. The engine uses the provider's native structured output or tool-calling when available, and falls back to JSON-in-prompt.
- Output is validated with Zod. On failure it sends a repair prompt with the validation errors (max N retries).
- Supports partial/streaming objects (`streamObject`).

### 6.3 Web extraction pipeline (`ai.extract({ url })`)

1. **Guard:** URL validation and SSRF protection (block private IPs and non-http(s) schemes), plus size and time limits.
2. **Fetch:** `fetch` by default. The Playwright fetcher is optional, for JS-rendered pages. Respect robots.txt (configurable).
3. **Fast path:** detect `schema.org` JSON-LD/microdata (e.g. `Recipe`). Map it directly and use the LLM only to normalize or fill gaps. This is cheaper and more accurate.
4. **Clean:** Readability → markdown, then strip nav, ads, and scripts. Truncate or chunk to fit the context window.
5. **LLM extract:** schema-guided prompt. Scraped content is wrapped as _untrusted data_ to defend against prompt injection.
6. **Return** `{ data, source: { url, title, method: "jsonld" | "llm" }, usage }`.

### 6.4 Chat

- Sessions are stored through the `Store` interface (memory, SQLite, Postgres, Redis).
- Tool loop: the model calls tools and the engine executes them with timeouts and max steps. Optional `requireApproval` on tools.
- Context management: sliding window plus optional summarization of old turns.
- Streams text, tool events, and usage over SSE.

### 6.5 AI search (RAG)

- `index.upsert / delete / query`. Chunking strategies (by tokens or markdown sections).
- Hybrid retrieval (vector + keyword/BM25 when the store supports it), metadata filters, optional rerank.
- `answer: true` generates a grounded answer with citations to result IDs.

### 6.6 Server & client

- `createHandler` exposes `/chat`, `/extract`, `/search`, and `/generate`. It adds an auth hook, per-user rate limiting, and a schema registry, so the client refers to schemas by name and can't send arbitrary prompts.
- React hooks: `useChat`, `useExtract`, `useSearch`. `ChatWidget` comes in headless and default-styled versions.

### 6.7 Cross-cutting

- Retries with exponential backoff and jitter, timeouts, and `AbortSignal` support everywhere.
- Cache (memory or Redis) keyed by provider + model + prompt hash + schema hash.
- Cost table per model, and an `onUsage` hook. OpenTelemetry spans are optional.
- Test utilities: `mockProvider()` with scripted responses, so app developers can unit-test AI features.

## 7. Security Checklist

- No API keys in client bundles. The server handler is the only path in.
- SSRF protection for URL fetching. Cap response size and redirects.
- Prompt-injection mitigation: delimit untrusted content, never let scraped text change tool permissions, and validate all outputs with schemas.
- Tool execution goes through an allowlist with optional human approval.
- Per-user rate limits and spend limits.
- PII: hooks for redaction before content is sent to a provider.

## 8. Roadmap

| Phase                         | Scope                                                                                                                                             | Done when                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **0. Setup** (week 1)         | Monorepo, TS strict, tsup builds (ESM+CJS), Vitest, Changesets, CI, lint                                                                          | `pnpm build && pnpm test` green in CI                 |
| **1. MVP** (weeks 2–4)        | core, anthropic/openai/gemini, `generate`, `extract` (text+URL, JSON-LD fast path), retries/fallback, usage, mockProvider, **recipe example app** | Recipe URL → typed object with all 3 providers        |
| **2. Chat** (weeks 5–6)       | chat + tools + streaming, stores (memory/sqlite), server handler, React hooks + ChatWidget                                                        | Embedded chatbot in example app that can save recipes |
| **3. Search** (weeks 7–8)     | embeddings, memory + pgvector stores, hybrid query, grounded answers                                                                              | "AI search" over saved recipes                        |
| **4. Hardening** (weeks 9–10) | Playwright fetcher, cache, OTel, rate/spend limits, docs site, more examples                                                                      | v1.0 release                                          |
| **Later**                     | Python port, React Native, Vue/Svelte, agents/workflows, file/PDF/image input, Ollama/local models                                                | —                                                     |

## 9. Testing Strategy

- Unit tests with `mockProvider` (deterministic). Contract tests run the same suite against every provider adapter.
- Recorded HTTP fixtures for fetcher and extract tests (no live network in CI).
- Opt-in live integration tests (`LIVE=1`) using real API keys.
- Eval set: about 30 real recipe URLs with expected fields, measuring extraction accuracy per provider.

## 10. Open Decisions

1. **Build on the Vercel AI SDK or write our own provider layer?** Building on it is faster and gives more providers. Writing our own means full control and fewer dependencies. _Recommendation:_ our own thin `Provider` interface, plus an adapter that can wrap any AI SDK model.
2. TypeScript only first, or TypeScript + Python? _Recommendation:_ TypeScript first.
3. Name/scope on npm: check availability of `ai-weave` / `@ai-weave`.
4. License: MIT.
