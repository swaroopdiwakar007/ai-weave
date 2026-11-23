# @ai-weave/gemini

Google Gemini provider for ai-weave. It uses `generateContent` via `fetch`, with no SDK dependency.

```ts
import { gemini } from "@ai-weave/gemini";
gemini({ model: "gemini-2.5-flash" }); // reads GEMINI_API_KEY, then GOOGLE_API_KEY
```

Options: `model` (default `gemini-2.5-flash`), `apiKey`, `baseURL`, `headers`, `fetch`.
Structured output uses `responseMimeType: application/json` plus `responseJsonSchema`. Thinking
tokens are counted as output tokens.
