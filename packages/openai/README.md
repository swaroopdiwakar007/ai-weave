# @ai-weave/openai

OpenAI provider for ai-weave. It uses Chat Completions via `fetch`, with no SDK dependency, and also
works with OpenAI-compatible servers.

```ts
import { openai } from "@ai-weave/openai";
openai({ model: "gpt-4o-mini" }); // reads OPENAI_API_KEY
openai({ id: "ollama", baseURL: "http://localhost:11434/v1", model: "llama3.1" });
openai({
  id: "openrouter",
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  model: "...",
});
```

Options: `model` (default `gpt-4o-mini`), `apiKey`, `baseURL`, `id`, `organization`,
`maxTokensParam` (`max_completion_tokens` | `max_tokens`), `capabilities` (e.g.
`{ structuredOutput: false }` for servers without `json_schema`), `headers`, `fetch`.

With a custom `baseURL`, `OPENAI_API_KEY` is **not** sent. Pass `apiKey` explicitly.
Structured output uses `response_format: json_schema` in non-strict mode, because strict mode
rejects optional fields. Zod validates the result.
