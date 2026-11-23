# ai-weave

[![CI](https://github.com/swaroopdiwakar007/ai-weave/actions/workflows/ci.yml/badge.svg)](https://github.com/swaroopdiwakar007/ai-weave/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![Providers](https://img.shields.io/badge/providers-Claude%20%7C%20OpenAI%20%7C%20Gemini-8a2be2)

**Add AI features to your app in a few lines.** Extract typed data from URLs and text, classify,
summarize, and generate with Claude, OpenAI or Gemini. You can swap providers by changing one line.

```ts
import { createWeave } from "@ai-weave/core";
import { anthropic } from "@ai-weave/anthropic";
import { webFetcher } from "@ai-weave/web";
import { z } from "zod";

const ai = createWeave({ provider: anthropic(), fetcher: webFetcher() });
const Recipe = z.object({
  title: z.string(),
  ingredients: z.array(z.string()),
  steps: z.array(z.string()),
});
const { data } = await ai.extract({
  url: "https://www.bbcgoodfood.com/recipes/easy-pancakes",
  schema: Recipe,
});
// data: { title: string; ingredients: string[]; steps: string[] }
```

> **Status: Phase 1 (v0.1).** Shipped: `generate`, `generateObject`, `extract`, `classify`, `summarize`,
> 3 providers, retries/fallback, usage and cost, and the safe web fetcher.
> Next up: chat, the server handler and React (Phase 2), then AI search (Phase 3). See [PLAN.md](./PLAN.md).

## Packages

| Package                                       | What it does                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| [`@ai-weave/core`](./packages/core)           | `createWeave`, tasks, structured output, retries, fallback, usage, `mockProvider` |
| [`@ai-weave/anthropic`](./packages/anthropic) | Claude (Messages API)                                                             |
| [`@ai-weave/openai`](./packages/openai)       | OpenAI plus OpenAI-compatible servers (Ollama, vLLM, OpenRouter…)                 |
| [`@ai-weave/gemini`](./packages/gemini)       | Google Gemini                                                                     |
| [`@ai-weave/web`](./packages/web)             | SSRF-safe URL fetching, HTML to markdown, schema.org JSON-LD                      |

The provider adapters talk to the vendor REST APIs with `fetch`. They have **no SDK dependencies** and
work on Node 18+, Bun, Deno and edge runtimes. The only peer dependency is `zod` v4.

```bash
npm i @ai-weave/core @ai-weave/anthropic @ai-weave/web zod
```

## Switching providers and adding fallbacks

```ts
import { openai } from "@ai-weave/openai";
import { gemini } from "@ai-weave/gemini";

const ai = createWeave({
  provider: anthropic({ model: "claude-sonnet-4-5" }), // ANTHROPIC_API_KEY
  fallback: [openai({ model: "gpt-4o-mini" }), gemini()], // tried in order if the primary fails
  retry: { maxRetries: 2 }, // per provider, exponential backoff + jitter
  timeoutMs: 60_000,
  onUsage: (u) => console.log(u.task, u.provider, u.totalTokens, u.costUsd),
});
```

## Tasks

```ts
await ai.generate({ prompt: "Write a haiku about soup" }); // { text, toolCalls, usage }
await ai.generateObject({ schema: Recipe, prompt: "Invent a recipe" }); // { data, usage, repairs }
await ai.extract({ text | url | page, schema, instructions?, jsonLd? }); // { data, source, usage }
await ai.classify({ input: "Chocolate cake", labels: ["dessert", "main", "side"] }); // { label }
await ai.summarize({ input: longText, maxWords: 50, format: "bullets" }); // { text }
```

- **Structured output** uses each provider's native mode: Claude via forced tool use, OpenAI via
  `json_schema`, Gemini via `responseJsonSchema`. It falls back to JSON-in-prompt for other providers.
  Output is validated with Zod. If it's invalid, the model gets the validation errors and is asked
  to repair (`maxRepairs`, default 2).
- **JSON-LD fast path:** many sites (most recipe sites) embed schema.org data. With
  `jsonLd: { type: "Recipe", map }`, a valid mapped result is returned **with zero LLM calls**.
  If you leave out `map`, only the small JSON-LD node goes to the model (`method: "hybrid"`).
  When the JSON-LD is missing or incomplete, the cleaned page goes to the model (`method: "llm"`).
- **Usage:** every result includes
  `usage { provider, model, inputTokens, outputTokens, costUsd, latencyMs, calls }`.

## Testing your AI features

```ts
import { mockProvider } from "@ai-weave/core/testing";

const provider = mockProvider({
  responses: [{ json: { title: "Soup", ingredients: ["water"], steps: ["Boil"] } }],
});
const ai = createWeave({ provider });
// ...run your code, then inspect provider.calls
```

## Security notes

- **Keep API keys on the server.** Provider packages read `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
  and `GEMINI_API_KEY`. Don't bundle them into client code. (The Phase 2 server handler will be the
  supported path for browsers.)
- **SSRF:** `webFetcher()` allows only http(s). It blocks loopback, private, link-local (cloud
  metadata) and reserved addresses, and checks DNS answers and every redirect hop. It also caps size
  (5 MB), time (15 s) and redirects (5). DNS rebinding between the check and the connection is still
  possible. For strict isolation, send fetches through an egress proxy.
- **Prompt injection:**
  - Scraped or user content is wrapped in `<untrusted_content>` delimiters (escaped so it can't break
    out). The system prompt tells the model to treat it as data.
  - Extraction requests never include tools, so injected text can't trigger actions.
  - All outputs are schema-validated.
- **OpenAI-compatible base URLs:** the adapter doesn't send `OPENAI_API_KEY` to a custom `baseURL`
  unless you pass `apiKey` explicitly.

## Examples

- [`examples/recipe-app`](./examples/recipe-app): paste a recipe URL to get a typed recipe and save it.
  Run `pnpm --filter recipe-app demo` to try it offline.

## Project layout

```
packages/
  core/        createWeave, tasks, structured output, retries/fallback, usage, mockProvider
  anthropic/   Claude adapter
  openai/      OpenAI and OpenAI-compatible adapter
  gemini/      Gemini adapter
  web/         safe fetcher, HTML → markdown, JSON-LD
  search/      (planned: Phase 3)
  server/      (planned: Phase 2)
  react/       (planned: Phase 2)
examples/
  recipe-app/  URL → typed recipe CLI
tests/         provider contract suite, integration and live tests
```

## Roadmap

| Phase | Scope                                                                                       | Status |
| ----- | ------------------------------------------------------------------------------------------- | ------ |
| 0     | Monorepo, tooling, CI                                                                       | ✅     |
| 1     | Core tasks, 3 providers, extraction with JSON-LD fast path, web fetcher, recipe example     | ✅     |
| 2     | Chat with tools and streaming, session stores, server handler, React hooks and `ChatWidget` | ⏳     |
| 3     | AI search: embeddings, vector stores, hybrid retrieval, grounded answers                    | ⏳     |
| 4     | Caching, headless-browser fetcher, OpenTelemetry, rate and spend limits, v1.0               | ⏳     |

Full design: [PLAN.md](./PLAN.md).

## Development

```bash
corepack enable
pnpm install
pnpm build && pnpm lint && pnpm typecheck && pnpm test
pnpm test:coverage            # thresholds: ≥85% lines for core and web
LIVE=1 pnpm test:live          # real API calls; uses whichever API keys are set
pnpm changeset                 # describe a change for the changelog
```

## Contributing

Issues and PRs are welcome. Please run `pnpm build && pnpm lint && pnpm typecheck && pnpm test`
before opening a PR, and add a changeset (`pnpm changeset`) for user-facing changes.

## License

[MIT](./LICENSE)
