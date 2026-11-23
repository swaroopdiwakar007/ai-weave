# @ai-weave/anthropic

Claude provider for ai-weave. It calls the Messages API with `fetch`, so there's no SDK dependency.

```ts
import { anthropic } from "@ai-weave/anthropic";
const provider = anthropic({ model: "claude-sonnet-4-5" }); // reads ANTHROPIC_API_KEY
```

Options: `model` (default `claude-sonnet-4-5`), `apiKey`, `baseURL`, `defaultMaxTokens` (default
4096, since the API requires `max_tokens`), `headers` (e.g. `anthropic-beta`), `fetch`.

Structured output uses a forced tool call. The tool input is returned as JSON text.
