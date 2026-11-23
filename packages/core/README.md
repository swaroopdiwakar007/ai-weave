# @ai-weave/core

Provider-agnostic AI tasks for apps: `generate`, `generateObject`, `extract`, `classify`, `summarize`.
It handles structured output with Zod, retries, fallback across providers, timeouts and usage/cost tracking.

```bash
npm i @ai-weave/core zod
```

## `createWeave(config)`

| Option                                             | Default                                                 | Description                                                              |
| -------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `provider`                                         | required                                                | Primary `Provider` (`anthropic()`, `openai()`, `gemini()`, or your own)  |
| `fallback`                                         | `[]`                                                    | Providers tried in order after the primary fails (after its retries)     |
| `retry`                                            | `{ maxRetries: 2, baseDelayMs: 500, maxDelayMs: 8000 }` | Per-provider retry for retryable errors. `false` disables it             |
| `timeoutMs`                                        | `60000`                                                 | Per call                                                                 |
| `fetcher`                                          | none                                                    | Required for `extract({ url })`. Use `webFetcher()` from `@ai-weave/web` |
| `pricing`                                          | built-in table                                          | `{ "provider:modelPrefix": { input, output } }` in USD per 1M tokens     |
| `onRequest` / `onResponse` / `onError` / `onUsage` | none                                                    | Hooks. Errors thrown in hooks are ignored                                |

Fallback applies to every provider error (auth, rate limit, 5xx, context length, timeout). It doesn't
apply to `AbortError` or `ConfigError`. When every provider fails you get `AllProvidersFailedError`
with `.errors`.

## Tasks

All tasks accept `signal` (an `AbortSignal`) and `providerOptions` keyed by provider id. Only the
active provider's entry is sent:
`providerOptions: { openai: { seed: 1 }, anthropic: { metadata: { user_id: "u1" } } }`.

### `extract({ schema, text | url | page, instructions?, jsonLd?, maxContentChars?, maxRepairs? })`

Returns `{ data, source: { kind, url, title, method, truncated }, usage }`. `method` is one of:

- `"jsonld"`: `jsonLd.map(node)` validated against your schema, with no LLM call.
- `"hybrid"`: only the matching JSON-LD node was sent to the model.
- `"llm"`: the cleaned page or text was sent (relevant JSON-LD is appended as extra context).

Content is wrapped in `<untrusted_content>` and the model is told never to follow instructions
inside it. See `EXTRACT_SYSTEM_PROMPT`.

### `generateObject({ schema, prompt | messages, system?, maxRepairs? })`

Uses native structured output when `provider.capabilities.structuredOutput` is true, and
JSON-in-prompt otherwise. Non-object schemas (e.g. `z.array(...)`) are wrapped and unwrapped for you.
If the output still fails validation after `maxRepairs` repair attempts, it throws `ValidationError`
with `.issues` and `.rawOutput`.

### `generate({ prompt | messages, system?, tools?, toolChoice?, temperature?, maxTokens? })`

Returns `{ text, toolCalls, finishReason, usage }`.

### `classify({ input, labels })`, `summarize({ input, maxWords?, format? })`

## Errors

`WeaveError` › `ConfigError`, `AbortError`, `ValidationError`, `FetchError`, `AllProvidersFailedError`,
`ProviderError` › `AuthError`, `RateLimitError` (`retryAfterMs`), `ContextLengthError`,
`ContentFilterError`, `TimeoutError`. Check `error.retryable`.

## Writing a provider

Implement `Provider { id, model, capabilities, generate(request, { signal }) }`. `postJson`,
`resolveApiKey` and `errorFromStatus` map HTTP errors onto the taxonomy for you. When
`request.responseFormat` is set, return the JSON as `response.text`.

## Testing

```ts
import { mockProvider } from "@ai-weave/core/testing";
const provider = mockProvider({
  responses: ["text", { json: { a: 1 } }, new RateLimitError("slow down")],
});
```
